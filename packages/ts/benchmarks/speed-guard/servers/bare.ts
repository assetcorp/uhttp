import { createRequire } from 'node:module'
import { ROUTE_BODY, ROUTE_PATH } from '../constants.ts'

type Uws = typeof import('uWebSockets.js')

const uws = createRequire(import.meta.url)('uWebSockets.js') as Uws

uws
  .App()
  .get(ROUTE_PATH, res => {
    res.writeHeader('content-type', 'text/plain; charset=UTF-8').end(ROUTE_BODY)
  })
  .listen('127.0.0.1', 0, listenSocket => {
    if (!listenSocket) {
      console.error('The uWebSockets.js server failed to listen on 127.0.0.1.')
      process.exit(1)
    }
    console.log(JSON.stringify({ port: uws.us_socket_local_port(listenSocket) }))
  })
