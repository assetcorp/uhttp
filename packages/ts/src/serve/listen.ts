import type { TemplatedApp, us_listen_socket } from 'uWebSockets.js'
import { lstat, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { UNIX_SOCKET_PROBE_MS } from '../constants.js'
import { UhttpError } from '../errors.js'
import type { Uws } from './native.js'

/**
 * The server listens on a port and an optional host, or on a Unix socket path.
 *
 * @internal
 */
export interface ListenAddress {
  /** The server listens on this port, unless it listens on a Unix socket. */
  readonly port: number | undefined
  /** The server listens on this host, or on every interface when this is `undefined`. */
  readonly host: string | undefined
  /** The server listens on this Unix socket path, when you pass one. */
  readonly path: string | undefined
}

/**
 * The package holds the listening socket of a server through this interface.
 *
 * @internal
 */
export interface Listener {
  /** The server listens on this port, and it is `undefined` for a Unix socket. */
  readonly port: number | undefined
  /**
   * Stops accepting connections, and removes the socket file of a Unix socket.
   *
   * @returns The promise settles once the socket file has gone, and a second call returns the
   * same promise.
   */
  close(): Promise<void>
}

function listenFailed(message: string, cause?: unknown): UhttpError {
  return new UhttpError('LISTEN_FAILED', message, cause === undefined ? undefined : { cause })
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

function serverAnswers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ path })
    const settle = (answers: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(answers)
    }
    const timer = setTimeout(() => settle(true), UNIX_SOCKET_PROBE_MS)
    socket.once('connect', () => settle(true))
    socket.once('error', error => settle(errorCode(error) !== 'ECONNREFUSED'))
  })
}

async function claimSocketPath(path: string): Promise<void> {
  let isSocket: boolean
  try {
    isSocket = (await lstat(path)).isSocket()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw listenFailed(`The server could not inspect the Unix socket path ${path}.`, error)
  }
  if (!isSocket) throw listenFailed(`A file that is not a socket holds the Unix socket path ${path}.`)
  if (await serverAnswers(path)) throw listenFailed(`A running server holds the Unix socket path ${path}.`)
  try {
    await unlink(path)
  } catch (error) {
    throw listenFailed(`The server could not remove the stale socket at ${path}.`, error)
  }
}

function bind(native: TemplatedApp, address: ListenAddress): Promise<us_listen_socket | false> {
  return new Promise(resolve => {
    const { port, host, path } = address
    if (path !== undefined) native.listen_unix(resolve, path)
    else if (host === undefined) native.listen(port ?? 0, resolve)
    else native.listen(host, port ?? 0, resolve)
  })
}

async function removeSocketFile(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSocket()) await unlink(path)
  } catch {
    return
  }
}

/**
 * Starts listening on a port or on a Unix socket path. Before it listens on a Unix socket, the
 * function refuses a path that a file other than a socket holds, and a socket on which a server
 * answers within {@link UNIX_SOCKET_PROBE_MS}, and it removes a socket on which no server answers.
 *
 * @param uws - The package passes the module of uWebSockets.js.
 * @param native - The package passes the app of uWebSockets.js that accepts the connections.
 * @param address - The package passes the address to listen on.
 * @returns The promise resolves to the listener once the server listens.
 * @throws {@link UhttpError} with the code `LISTEN_FAILED` when the operating system can't bind the
 * address or another file or server holds the Unix socket path.
 * @internal
 */
export async function listenOn(uws: Uws, native: TemplatedApp, address: ListenAddress): Promise<Listener> {
  const { port, host, path } = address
  if (path !== undefined) await claimSocketPath(path)
  const listenSocket = await bind(native, address)
  if (listenSocket === false) {
    const where = path === undefined ? `${host ?? 'every interface'} on port ${port}` : `the Unix socket path ${path}`
    throw listenFailed(`The operating system could not bind ${where}.`)
  }
  let closing: Promise<void> | undefined
  const close = async (): Promise<void> => {
    uws.us_listen_socket_close(listenSocket)
    if (path !== undefined) await removeSocketFile(path)
  }
  return {
    port: path === undefined ? uws.us_socket_local_port(listenSocket) : undefined,
    close() {
      closing ??= close()
      return closing
    },
  }
}
