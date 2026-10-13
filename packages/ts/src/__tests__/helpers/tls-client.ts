import { connect, type TLSSocket } from 'node:tls'
import { afterEach } from 'vitest'
import { HttpConnection } from './http-client.js'

const LOOPBACK = '127.0.0.1'

export interface TlsConnection {
  readonly http: HttpConnection
  readonly commonName: string | undefined
  readonly socket: TLSSocket
}

const sockets = new Set<TLSSocket>()

afterEach(() => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
})

export function openTlsConnection(port: number, servername: string): Promise<TlsConnection> {
  const { promise, resolve, reject } = Promise.withResolvers<TlsConnection>()
  const socket = connect({ port, host: LOOPBACK, servername, rejectUnauthorized: false })
  sockets.add(socket)
  const http = new HttpConnection(socket)
  socket.once('secureConnect', () => {
    const commonName = socket.getPeerCertificate().subject?.CN
    resolve({ http, commonName: Array.isArray(commonName) ? commonName[0] : commonName, socket })
  })
  socket.once('error', reject)
  return promise
}
