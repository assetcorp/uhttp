import { connect, type TLSSocket } from 'node:tls'
import { afterEach } from 'vitest'
import { HttpConnection, requestHead } from './http-client.js'

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

export interface ThreadSeen {
  readonly commonName: string | undefined
  readonly thread: string
}

export async function fetchThread(port: number, servername: string): Promise<ThreadSeen> {
  const connection = await openTlsConnection(port, servername)
  const response = await connection.http.exchange(requestHead('GET', '/thread'))
  connection.socket.destroy()
  return { commonName: connection.commonName, thread: response.body.toString() }
}
