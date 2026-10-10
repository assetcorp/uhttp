import { connect, type Socket } from 'node:net'
import { afterEach } from 'vitest'
import { parseResponse, type ReceivedResponse, readHead } from './http-response.js'

const LOOPBACK = '127.0.0.1'
const DEFAULT_WAIT_MS = 2_000
const PREVIEW_BYTES = 400
const CRLF = Buffer.from('\r\n')
const LAST_CHUNK = Buffer.from('0\r\n\r\n')
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED'])

export type ConnectionState = 'open' | 'closed' | 'reset'

export interface ResponseOptions {
  method?: string
  waitMs?: number
}

function codeOf(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : error.message
}

const connections = new Set<HttpConnection>()

afterEach(() => {
  for (const connection of connections) connection.destroy()
  connections.clear()
})

export class HttpConnection {
  readonly #socket: Socket
  readonly #listeners = new Set<() => void>()
  readonly #writes = new Set<Promise<void>>()
  #received = Buffer.alloc(0)
  #serverEnded = false
  #socketClosed = false
  #errorCode: string | undefined

  constructor(socket: Socket) {
    this.#socket = socket
    socket.on('data', chunk => {
      this.#received = Buffer.concat([this.#received, chunk])
      this.#changed()
    })
    socket.on('end', () => {
      this.#serverEnded = true
      this.#changed()
    })
    socket.on('close', () => {
      this.#socketClosed = true
      this.#changed()
    })
    socket.on('error', error => {
      this.#errorCode ??= codeOf(error)
      this.#changed()
    })
  }

  get state(): ConnectionState {
    if (this.#errorCode !== undefined && RESET_CODES.has(this.#errorCode)) return 'reset'
    return this.#serverEnded || this.#socketClosed ? 'closed' : 'open'
  }

  get errorCode(): string | undefined {
    return this.#errorCode
  }

  write(data: string | Uint8Array): Promise<void> {
    const written = new Promise<void>(resolve => {
      if (!this.#socket.writable) {
        resolve()
        return
      }
      this.#socket.write(data, () => resolve())
    })
    this.#writes.add(written)
    void written.then(() => this.#writes.delete(written))
    return written
  }

  pauseReading(): void {
    this.#socket.pause()
  }

  resumeReading(): void {
    this.#socket.resume()
  }

  interim(waitMs = DEFAULT_WAIT_MS): Promise<number> {
    return this.#waitFor(
      waitMs,
      () => {
        const head = readHead(this.#received, 0)
        if (head === undefined) {
          if (this.state !== 'open') throw new Error(`${this.#ending()} before a status line. ${this.#unread()}`)
          return undefined
        }
        if (head.status < 200) this.#received = this.#received.subarray(head.next)
        return head.status
      },
      () => {
        throw new Error(`The server sent no status line for ${waitMs} ms. ${this.#unread()}`)
      },
    )
  }

  response(options: ResponseOptions = {}): Promise<ReceivedResponse> {
    const method = options.method ?? 'GET'
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
    return this.#waitFor(
      waitMs,
      () => {
        const parsed = parseResponse(this.#received, method, this.state !== 'open')
        if (parsed !== undefined) {
          this.#received = this.#received.subarray(parsed.consumed)
          return parsed.response
        }
        if (this.state !== 'open') throw new Error(`${this.#ending()} before the response ended. ${this.#unread()}`)
        return undefined
      },
      () => {
        throw new Error(`The server sent nothing more for ${waitMs} ms. ${this.#unread()}`)
      },
    )
  }

  exchange(request: string | Uint8Array, options: ResponseOptions = {}): Promise<ReceivedResponse> {
    void this.write(request)
    return this.response(options)
  }

  async waitForClose(waitMs = DEFAULT_WAIT_MS): Promise<ConnectionState> {
    const state = await this.#waitFor<ConnectionState>(
      waitMs,
      () => {
        if (this.#received.length > 0) {
          throw new Error(`The server sent bytes after the last response. ${this.#unread()}`)
        }
        return this.state === 'open' ? undefined : this.state
      },
      () => 'open',
    )
    if (state !== 'closed') return state
    await Promise.all(this.#writes)
    this.#socket.end()
    await this.#waitFor(
      waitMs,
      () => (this.#socketClosed ? true : undefined),
      () => {
        throw new Error(`The socket stayed open for ${waitMs} ms after both sides closed it.`)
      },
    )
    return this.state
  }

  destroy(): void {
    this.#socket.destroy()
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener()
  }

  #ending(): string {
    return this.state === 'reset'
      ? `The server reset the connection (${this.#errorCode})`
      : 'The server closed the connection'
  }

  #unread(): string {
    const preview = JSON.stringify(this.#received.subarray(0, PREVIEW_BYTES).toString('latin1'))
    return `The client holds ${this.#received.length} unread bytes: ${preview}.`
  }

  #waitFor<T>(waitMs: number, check: () => T | undefined, timedOut: () => T): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const listeners = this.#listeners
    const timer = setTimeout(() => settle(timedOut), waitMs)
    function stop(): void {
      clearTimeout(timer)
      listeners.delete(attempt)
    }
    function settle(produce: () => T | undefined): void {
      let result: T | undefined
      try {
        result = produce()
      } catch (error) {
        stop()
        reject(error)
        return
      }
      if (result === undefined) return
      stop()
      resolve(result)
    }
    function attempt(): void {
      settle(check)
    }
    listeners.add(attempt)
    attempt()
    return promise
  }
}

export function openConnection(port: number): Promise<HttpConnection> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpConnection>()
  const socket = connect({ port, host: LOOPBACK, allowHalfOpen: true })
  const connection = new HttpConnection(socket)
  connections.add(connection)
  socket.once('connect', () => resolve(connection))
  socket.once('close', () => reject(new Error(`The client could not connect to port ${port}.`)))
  return promise
}

export async function send(
  port: number,
  request: string | Uint8Array,
  options: ResponseOptions = {},
): Promise<{ connection: HttpConnection; response: ReceivedResponse }> {
  const connection = await openConnection(port)
  return { connection, response: await connection.exchange(request, options) }
}

export function requestHead(method: string, target: string, lines: readonly string[] = []): string {
  return [`${method} ${target} HTTP/1.1`, 'Host: localhost', ...lines, '', ''].join('\r\n')
}

export function requestWithBody(
  method: string,
  target: string,
  lines: readonly string[],
  body: string | Uint8Array,
): Buffer {
  const bytes = Buffer.from(body)
  return Buffer.concat([Buffer.from(requestHead(method, target, [...lines, `Content-Length: ${bytes.length}`])), bytes])
}

export function chunked(pieces: readonly (string | Uint8Array)[]): Buffer {
  const frames = pieces.flatMap(piece => {
    const bytes = Buffer.from(piece)
    if (bytes.length === 0) throw new Error('A chunked request cannot hold an empty piece, because 0 ends the body.')
    return [Buffer.from(`${bytes.length.toString(16)}\r\n`), bytes, CRLF]
  })
  return Buffer.concat([...frames, LAST_CHUNK])
}

export function chunkedRequest(
  method: string,
  target: string,
  lines: readonly string[],
  pieces: readonly (string | Uint8Array)[],
): Buffer {
  return Buffer.concat([
    Buffer.from(requestHead(method, target, [...lines, 'Transfer-Encoding: chunked'])),
    chunked(pieces),
  ])
}
