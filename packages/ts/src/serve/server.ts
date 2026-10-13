import { UhttpError } from '../errors.js'

/**
 * {@link serve} resolves to a `Server`, through which you can find the port, close the server, and
 * renew its certificates.
 */
export interface Server {
  /**
   * The server listens on this port, which the operating system assigns when you pass port 0. The
   * port is `undefined` for a server on a Unix socket.
   */
  readonly port: number | undefined
  /**
   * Closes the server without dropping a request in progress. The server closes its listening
   * socket and closes every WebSocket with the code 1001. It sends a 503 with `Connection: close`
   * in response to every new request on an open connection. It closes the idle connections of a
   * thread once no request is in progress on that thread. Once `gracePeriodMs` passes, it closes
   * every connection that is left and then stops every worker thread. The package installs no
   * signal handler, so call this method from a handler of your own, such as one for `SIGTERM`.
   *
   * @returns The promise settles once the server is closed. A second call returns the same promise.
   */
  close(): Promise<void>
  /**
   * Loads the key file and the certificate file of `tls` again, and serves every new connection
   * with the renewed certificates. The server builds new apps with the renewed certificates before
   * it stops sending new connections to the old apps. It then closes each old connection after its
   * next reply. It closes the idle old connections of a thread once no old request is in progress
   * on that thread. Once `gracePeriodMs` passes, it closes every old connection that is left. With
   * worker threads, the server starts a new set of workers and lets the old workers finish their
   * requests. A second call waits until the first call finishes.
   *
   * @returns The promise resolves once the server sends the renewed certificates to every new client.
   * @throws {@link UhttpError} with the code `INVALID_CERTIFICATE` when the package fails to load a
   * renewed file, in which case the server goes on serving with the old certificates. The method
   * throws the code `INVALID_SERVE_OPTIONS` on a server without `tls`, and the code
   * `SERVER_CLOSING` once {@link Server.close} starts. It throws the code `APP_START_FAILED` when a
   * new worker fails to build the app.
   */
  reload(): Promise<void>
}

/**
 * The package closes and reloads one kind of server through this interface.
 *
 * @internal
 */
export interface ServerControl {
  /** Closes the server. The package calls this method once. */
  close(): Promise<void>
  /** Renews the certificates. The package calls this method for one reload at a time. */
  reload(): Promise<void>
}

/**
 * Returns the error that {@link Server.reload} throws once the server starts to close.
 *
 * @returns The function returns a new `SERVER_CLOSING` error.
 * @internal
 */
export function closingError(): UhttpError {
  return new UhttpError('SERVER_CLOSING', 'Call server.reload() before server.close(), because the server is closing.')
}

/**
 * Returns the error that {@link Server.reload} throws on a server without `tls`.
 *
 * @returns The function returns a new `INVALID_SERVE_OPTIONS` error.
 * @internal
 */
export function reloadWithoutTlsError(): UhttpError {
  return new UhttpError(
    'INVALID_SERVE_OPTIONS',
    'server.reload() renews the certificates of tls, so pass tls to serve().',
  )
}

/**
 * Returns the server that {@link serve} resolves to, which closes only once and performs one reload
 * at a time.
 *
 * @param port - The package passes the port that the server listens on.
 * @param control - The package passes the functions that close and reload this kind of server.
 * @returns The function returns the server.
 * @internal
 */
export function serverOf(port: number | undefined, control: ServerControl): Server {
  let closing: Promise<void> | undefined
  let reloads: Promise<void> = Promise.resolve()
  return {
    port,
    close() {
      closing ??= control.close()
      return closing
    },
    reload() {
      if (closing !== undefined) return Promise.reject(closingError())
      const reload = reloads.then(() => control.reload())
      reloads = reload.catch(() => undefined)
      return reload
    },
  }
}
