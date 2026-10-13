import { UhttpError } from '../errors.js'

/**
 * You get a `Server` from {@link serve}, and you can find its port, close it, or renew its
 * certificates through this object.
 */
export interface Server {
  /**
   * The server listens on this port, which the operating system assigns when you pass port 0. The
   * port is `undefined` for a server on a Unix socket.
   */
  readonly port: number | undefined
  /**
   * Closes the server without dropping a request in progress. The server stops accepting
   * connections and closes every WebSocket with the code 1001. It answers every new request on an
   * open connection with a 503 and `Connection: close`, and it closes the idle connections of a
   * thread once no request is in progress on that thread. Once `gracePeriodMs` has passed, it closes
   * every connection that is left, and then it stops every worker thread. The package installs no signal handler, so call
   * this method from a handler of your own, such as one for `SIGTERM`.
   *
   * @returns The promise settles once the server has closed, and a second call returns the same
   * promise.
   */
  close(): Promise<void>
  /**
   * Reads the key and the certificate files of `tls` again and serves every new connection with
   * them. The server builds new apps with the renewed certificates before it stops sending new
   * connections to the old ones. It then closes each old connection after its next reply, closes
   * the idle old connections once no old request is in progress, and closes every old connection
   * that is left once `gracePeriodMs` has passed. With worker threads, the server starts a new set
   * of workers and lets the old ones finish. A second call waits until the first one has finished.
   *
   * @returns The promise resolves once the server sends the renewed certificates to every new client.
   * @throws {@link UhttpError} with the code `INVALID_CERTIFICATE` when the package can't use a
   * renewed file, in which case the server goes on serving with the old certificates. It throws
   * the code `INVALID_SERVE_OPTIONS` on a server without `tls`, the code `SERVER_CLOSING` once
   * {@link Server.close} has started, and the code `APP_START_FAILED` when a new worker fails to
   * build the app.
   */
  reload(): Promise<void>
}

/**
 * The package closes and reloads one kind of server through this interface.
 *
 * @internal
 */
export interface ServerControl {
  /** Closes the server, and the package calls this method once. */
  close(): Promise<void>
  /** Renews the certificates, and the package calls this method for one reload at a time. */
  reload(): Promise<void>
}

/**
 * Returns the error that {@link Server.reload} throws once the server has started to close.
 *
 * @returns The function returns a new `SERVER_CLOSING` error.
 * @internal
 */
export function closingError(): UhttpError {
  return new UhttpError('SERVER_CLOSING', 'The server is closing, so it renews no certificate.')
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
 * Returns the server that {@link serve} resolves to, which closes once and runs one reload at a
 * time.
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
