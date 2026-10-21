import { createRequire } from 'node:module'
import { ROUTE_BODY, ROUTE_PATH } from '../constants.ts'

type Uws = typeof import('uWebSockets.js')

const uws = createRequire(import.meta.url)('uWebSockets.js') as Uws

function headBytes(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  const owned = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(owned).set(bytes)
  return owned
}

const head = headBytes('200 OK\r\ncontent-type: text/plain; charset=UTF-8')

uws
  .App()
  .get(ROUTE_PATH, res => {
    res.writeStatus(head).end(ROUTE_BODY)
  })
  .listen('127.0.0.1', 0, listenSocket => {
    if (!listenSocket) {
      console.error('The uWebSockets.js server failed to listen on 127.0.0.1.')
      process.exit(1)
    }
    console.log(JSON.stringify({ port: uws.us_socket_local_port(listenSocket) }))
  })
