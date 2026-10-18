import type { TemplatedApp, us_listen_socket } from 'uWebSockets.js'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { LISTEN_EXCLUSIVE_PORT, LISTEN_SHARED_PORT, UNIX_SOCKET_PROBE_MS } from '../constants.js'
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
  /** When this is `true`, the operating system lets every server that sets `reusePort` share the port. */
  readonly reusePort: boolean
  /** The package sets the mode of the Unix socket file to this mode once the server listens. */
  readonly socketMode: number
}

/**
 * The package closes the listening socket of a server through this interface.
 *
 * @internal
 */
export interface Listener {
  /** The server listens on this port, which is `undefined` for a Unix socket. */
  readonly port: number | undefined
  /**
   * Closes the listening socket, and removes the socket file of a Unix socket.
   *
   * @returns The promise settles once the function removes the socket file. A second call returns
   * the same promise.
   */
  close(): Promise<void>
}

function listenFailed(message: string, cause?: unknown): UhttpError {
  return new UhttpError('LISTEN_FAILED', message, cause === undefined ? undefined : { cause })
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

function serverListensOn(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ path })
    const settle = (listening: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(listening)
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
  if (!isSocket) throw listenFailed(`The file at the Unix socket path ${path} is not a socket.`)
  if (await serverListensOn(path)) throw listenFailed(`A server listens on the Unix socket path ${path}.`)
  try {
    await unlink(path)
  } catch (error) {
    throw listenFailed(`The server could not remove the stale socket at ${path}.`, error)
  }
}

function bind(native: TemplatedApp, address: ListenAddress): Promise<us_listen_socket | false> {
  return new Promise(resolve => {
    const { port, host, path } = address
    const options = address.reusePort ? LISTEN_SHARED_PORT : LISTEN_EXCLUSIVE_PORT
    if (path !== undefined) native.listen_unix(resolve, path)
    else if (host === undefined) native.listen(port ?? 0, options, resolve)
    else native.listen(host, port ?? 0, options, resolve)
  })
}

async function setSocketMode(uws: Uws, listenSocket: us_listen_socket, path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (error) {
    uws.us_listen_socket_close(listenSocket)
    await removeSocketFile(path)
    throw listenFailed(`The server could not set the mode of the Unix socket at ${path}.`, error)
  }
}

async function removeSocketFile(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSocket()) await unlink(path)
  } catch {
    return
  }
}

/**
 * Starts listening on a port or on a Unix socket path. The function binds a port exclusively,
 * unless `reusePort` is `true`. Before it listens on a Unix socket, the function throws when the
 * file at the path is not a socket. It removes an existing socket when a connection to that socket
 * fails with `ECONNREFUSED` within {@link UNIX_SOCKET_PROBE_MS}, while it throws for any other
 * outcome of that connection. Once it listens on a Unix socket, it sets the mode of the socket
 * file, because the mode that uWebSockets.js sets before the bind has no effect on the file.
 *
 * @param uws - The package passes the module of uWebSockets.js.
 * @param native - The package passes the app of uWebSockets.js that receives the connections.
 * @param address - The package passes the address to listen on.
 * @returns The promise resolves to the listener once the server listens.
 * @throws {@link UhttpError} with the code `LISTEN_FAILED` when the operating system fails to bind
 * the address, when the file at the Unix socket path is not a socket or is a socket in use, or when
 * the function fails to set the mode of the socket file.
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
  if (path !== undefined) await setSocketMode(uws, listenSocket, path, address.socketMode)
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
