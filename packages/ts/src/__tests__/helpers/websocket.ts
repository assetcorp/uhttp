import { createHash, randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { afterEach } from 'vitest'

const RFC_6455_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_WAIT_MS = 2_000

export function websocketKey(): string {
  return randomBytes(16).toString('base64')
}

export function expectedAccept(key: string): string {
  return createHash('sha1')
    .update(key + RFC_6455_GUID)
    .digest('base64')
}

export function handshakeHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    host: 'localhost',
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': websocketKey(),
    'sec-websocket-version': '13',
    ...overrides,
  }
}

export function upgradeHead(path: string, headers: Record<string, string>): string {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
  return `GET ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`
}

export interface RawHandshake {
  status: number
  headers: Map<string, string[]>
  rest: Buffer
  socket: Socket
}

const rawSockets = new Set<Socket>()

afterEach(() => {
  for (const socket of rawSockets) socket.destroy()
  rawSockets.clear()
})

export function rawHandshake(port: number, request: string, waitMs = DEFAULT_WAIT_MS): Promise<RawHandshake> {
  const { promise, resolve, reject } = Promise.withResolvers<RawHandshake>()
  const socket = connect({ port, host: '127.0.0.1' })
  rawSockets.add(socket)
  let received = Buffer.alloc(0)
  const timer = setTimeout(() => reject(new Error(`No response head within ${waitMs} ms.`)), waitMs)
  socket.on('data', chunk => {
    received = Buffer.concat([received, chunk])
    const end = received.indexOf('\r\n\r\n')
    if (end === -1) return
    clearTimeout(timer)
    socket.pause()
    socket.removeAllListeners('data')
    const [statusLine = '', ...lines] = received.subarray(0, end).toString('latin1').split('\r\n')
    const headers = new Map<string, string[]>()
    for (const line of lines) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).trim().toLowerCase()
      headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()])
    }
    resolve({ status: Number(statusLine.split(' ')[1]), headers, rest: received.subarray(end + 4), socket })
  })
  socket.on('error', error => {
    clearTimeout(timer)
    reject(error)
  })
  socket.write(request)
  return promise
}

export async function bodyOf(reply: RawHandshake, waitMs = DEFAULT_WAIT_MS): Promise<string> {
  const length = Number(reply.headers.get('content-length')?.[0] ?? '0')
  let body = reply.rest
  const { socket } = reply
  while (body.length < length) {
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The body ended short within ${waitMs} ms.`)), waitMs)
      socket.once('data', data => {
        clearTimeout(timer)
        socket.pause()
        resolve(data)
      })
      socket.resume()
    })
    body = Buffer.concat([body, chunk])
  }
  return body.subarray(0, length).toString()
}

export interface Closed {
  code: number
  reason: string
}

const sockets = new Set<WebSocket>()

afterEach(() => {
  for (const socket of sockets) socket.close()
  sockets.clear()
})

export class TestSocket {
  readonly socket: WebSocket
  readonly messages: (string | Uint8Array)[] = []
  readonly closed: Promise<Closed>
  readonly #waiters = new Set<() => void>()

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    const closed = Promise.withResolvers<Closed>()
    this.closed = closed.promise
    socket.addEventListener('message', event => {
      const data: unknown = event.data
      this.messages.push(data instanceof ArrayBuffer ? new Uint8Array(data) : String(data))
      for (const waiter of [...this.#waiters]) waiter()
    })
    socket.addEventListener('close', event => {
      closed.resolve({ code: event.code, reason: event.reason })
      for (const waiter of [...this.#waiters]) waiter()
    })
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }

  nextMessages(count: number, waitMs = DEFAULT_WAIT_MS): Promise<(string | Uint8Array)[]> {
    const { promise, resolve, reject } = Promise.withResolvers<(string | Uint8Array)[]>()
    const check = (): void => {
      if (this.messages.length < count) return
      clearTimeout(timer)
      this.#waiters.delete(check)
      resolve(this.messages.splice(0, count))
    }
    const timer = setTimeout(() => {
      this.#waiters.delete(check)
      reject(new Error(`The socket received ${this.messages.length} of ${count} messages within ${waitMs} ms.`))
    }, waitMs)
    this.#waiters.add(check)
    check()
    return promise
  }

  async nextMessage(waitMs = DEFAULT_WAIT_MS): Promise<string | Uint8Array> {
    const [message] = await this.nextMessages(1, waitMs)
    if (message === undefined) throw new Error('The socket received no message.')
    return message
  }

  async silence(waitMs: number): Promise<(string | Uint8Array)[]> {
    await new Promise(resolve => setTimeout(resolve, waitMs))
    return this.messages.splice(0)
  }
}

export function openSocket(port: number, path: string, protocols?: string | string[]): Promise<TestSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols)
  sockets.add(socket)
  const wrapped = new TestSocket(socket)
  const { promise, resolve, reject } = Promise.withResolvers<TestSocket>()
  socket.addEventListener('open', () => resolve(wrapped), { once: true })
  socket.addEventListener('error', () => reject(new Error(`The WebSocket to ${path} failed to open.`)), { once: true })
  return promise
}
