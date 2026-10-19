import type { HttpResponse } from 'uWebSockets.js'
import { createRequire } from 'node:module'
import { JSON_BODY, JSON_PATH, PLAIN_BODY, PLAIN_PATH, SECURITY_HEADERS, UPLOAD_PATH } from '../constants.ts'
import { announce, failToListen, securityHeadersRequested } from './announce.ts'

type Uws = typeof import('uWebSockets.js')

const uws = createRequire(import.meta.url)('uWebSockets.js') as Uws
const encoder = new TextEncoder()

function headerBytes(text: string): ArrayBuffer {
  const bytes = encoder.encode(text)
  const owned = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(owned).set(bytes)
  return owned
}

const contentTypeName = headerBytes('content-type')
const plainContentType = headerBytes('text/plain; charset=UTF-8')
const jsonContentType = headerBytes('application/json')
const securityHeaders = securityHeadersRequested()
  ? Object.entries(SECURITY_HEADERS).map(([name, value]) => [headerBytes(name), headerBytes(value)] as const)
  : []

function writeHead(res: HttpResponse, contentType: ArrayBuffer): void {
  res.writeHeader(contentTypeName, contentType)
  for (const [name, value] of securityHeaders) res.writeHeader(name, value)
}

uws
  .App()
  .get(PLAIN_PATH, res => {
    writeHead(res, plainContentType)
    res.end(PLAIN_BODY)
  })
  .get(JSON_PATH, res => {
    writeHead(res, jsonContentType)
    res.end(JSON.stringify(JSON_BODY))
  })
  .post(UPLOAD_PATH, res => {
    const chunks: Uint8Array[] = []
    let received = 0
    let aborted = false
    res.onAborted(() => {
      aborted = true
    })
    res.onData((chunk, isLast) => {
      chunks.push(new Uint8Array(chunk.slice(0)))
      received += chunk.byteLength
      if (!isLast || aborted) return
      const body = chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : Buffer.concat(chunks, received)
      res.cork(() => {
        writeHead(res, jsonContentType)
        res.end(JSON.stringify({ bytes: body.byteLength }))
      })
    })
  })
  .listen('127.0.0.1', 0, listenSocket => {
    if (!listenSocket) failToListen('uWebSockets.js')
    announce(uws.us_socket_local_port(listenSocket))
  })
