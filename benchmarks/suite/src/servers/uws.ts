import type { HttpResponse } from 'uWebSockets.js'
import { createRequire } from 'node:module'
import { JSON_BODY, JSON_PATH, PLAIN_BODY, PLAIN_PATH, SECURITY_HEADERS, UPLOAD_PATH } from '../constants.ts'
import { announce, failToListen, wantsSecurityHeaders } from './announce.ts'

type Uws = typeof import('uWebSockets.js')

const uws = createRequire(import.meta.url)('uWebSockets.js') as Uws
const securityHeaders = wantsSecurityHeaders() ? Object.entries(SECURITY_HEADERS) : []

function writeHead(res: HttpResponse, contentType: string): void {
  res.writeHeader('content-type', contentType)
  for (const [name, value] of securityHeaders) res.writeHeader(name, value)
}

uws
  .App()
  .get(PLAIN_PATH, res => {
    writeHead(res, 'text/plain; charset=UTF-8')
    res.end(PLAIN_BODY)
  })
  .get(JSON_PATH, res => {
    writeHead(res, 'application/json')
    res.end(JSON.stringify(JSON_BODY))
  })
  .post(UPLOAD_PATH, res => {
    let received = 0
    let aborted = false
    res.onAborted(() => {
      aborted = true
    })
    res.onData((chunk, isLast) => {
      received += chunk.byteLength
      if (!isLast || aborted) return
      res.cork(() => {
        writeHead(res, 'application/json')
        res.end(JSON.stringify({ bytes: received }))
      })
    })
  })
  .listen('127.0.0.1', 0, listenSocket => {
    if (!listenSocket) failToListen('uWebSockets.js')
    announce(uws.us_socket_local_port(listenSocket))
  })
