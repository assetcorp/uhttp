import { connect, type Socket } from 'node:net'

const HEAD_END = '\r\n\r\n'
const DEFAULT_TIMEOUT_MS = 2_000

export interface RawResponse {
  status: number
  headers: Map<string, string[]>
  body: Buffer
  closed: boolean
}

export interface RawRequestOptions {
  bodyless?: boolean
  timeoutMs?: number
}

function parseHead(head: string): { status: number; headers: Map<string, string[]> } {
  const [statusLine = '', ...lines] = head.split('\r\n')
  const status = Number(statusLine.split(' ')[1])
  const headers = new Map<string, string[]>()
  for (const line of lines) {
    const colon = line.indexOf(':')
    const name = line.slice(0, colon).toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers.set(name, [...(headers.get(name) ?? []), value])
  }
  return { status, headers }
}

function decodeChunked(data: Buffer): Buffer | undefined {
  const parts: Buffer[] = []
  let offset = 0
  while (true) {
    const lineEnd = data.indexOf('\r\n', offset)
    if (lineEnd === -1) return undefined
    const size = Number.parseInt(data.subarray(offset, lineEnd).toString(), 16)
    if (size === 0) return data.indexOf('\r\n', lineEnd + 2) === -1 ? undefined : Buffer.concat(parts)
    const start = lineEnd + 2
    if (data.length < start + size + 2) return undefined
    parts.push(data.subarray(start, start + size))
    offset = start + size + 2
  }
}

function completeBody(
  headers: Map<string, string[]>,
  status: number,
  data: Buffer,
  bodyless: boolean,
): Buffer | undefined {
  if (bodyless || status === 204 || status === 304) return Buffer.alloc(0)
  if (headers.get('transfer-encoding')?.includes('chunked')) return decodeChunked(data)
  const length = headers.get('content-length')?.[0]
  if (length === undefined) return undefined
  return data.length >= Number(length) ? data.subarray(0, Number(length)) : undefined
}

export function rawRequest(port: number, request: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1')
    let received = Buffer.alloc(0)
    let settled = false
    const finish = (closed: boolean): void => {
      if (settled) return
      const headEnd = received.indexOf(HEAD_END)
      if (headEnd === -1) {
        if (closed) {
          settled = true
          reject(new Error(`The server closed the connection after sending '${received.toString()}'.`))
        }
        return
      }
      const { status, headers } = parseHead(received.subarray(0, headEnd).toString('latin1'))
      const rest = received.subarray(headEnd + HEAD_END.length)
      const body = completeBody(headers, status, rest, options.bodyless === true)
      if (body === undefined && !closed) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ status, headers, body: body ?? rest, closed: body === undefined })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(
        new Error(
          `The server sent '${received.toString()}' and then nothing for ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms.`,
        ),
      )
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      finish(false)
    })
    socket.on('close', () => finish(true))
    socket.on('error', () => finish(true))
    socket.write(request)
  })
}

export function requestHead(method: string, target: string, lines: readonly string[] = []): string {
  return [`${method} ${target} HTTP/1.1`, 'Host: localhost', ...lines, '', ''].join('\r\n')
}
