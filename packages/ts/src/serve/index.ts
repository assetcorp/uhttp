import { SERVICE_UNAVAILABLE_STATUS } from '../constants.js'
import { UhttpError } from '../errors.js'
import { headerBytes } from '../headers.js'
import { statusLine } from '../native/head.js'
import { type Listener, listenOn } from './listen.js'
import { serveOnMainThread } from './main-thread.js'
import { loadUws, nativeAppOf, processOrigin, type Uws } from './native.js'
import { type CheckedServeOptions, checkedServeOptions, type ServeOptions } from './options.js'
import { type Server, serverOf } from './server.js'

export type { ServeOptions } from './options.js'
export type { Server } from './server.js'
export type { TlsCertificate, TlsOptions } from './tls-options.js'

const NO_WORKER_STATUS = headerBytes(statusLine(SERVICE_UNAVAILABLE_STATUS))
const NO_WORKER_BODY = headerBytes('No worker thread can serve this request.')

async function serveOnWorkers(uws: Uws, options: CheckedServeOptions, module: URL): Promise<Server> {
  const acceptor = await nativeAppOf(uws, options.tls, false)
  acceptor.any('/*', res => {
    res.writeStatus(NO_WORKER_STATUS).end(NO_WORKER_BODY, true)
  })
  const { Supervisor } = await import('../threads/supervisor.js')
  const supervisor = new Supervisor(acceptor, options, { module: module.href, origin: processOrigin() })
  let listener: Listener
  try {
    await supervisor.start()
    listener = await listenOn(uws, acceptor, options.address)
  } catch (error) {
    await supervisor.stop()
    acceptor.close()
    throw error
  }
  supervisor.onFatal(() => listener.close())
  return serverOf(listener.port, {
    close: async () => {
      await listener.close()
      await supervisor.stop()
      acceptor.close()
    },
    reload: () => supervisor.reload(),
  })
}

/**
 * Returns a server that listens on the address that you choose, once the package registers the
 * routes of the app with uWebSockets.js. With `threads`, each worker thread imports the module at
 * the URL that you pass and builds its own app from it. The main thread receives each connection
 * and passes it to a worker. It also replaces a worker that crashes. The server exits with an error
 * when no worker is left, when workers crash `crashLimit` times within `crashWindowMs`, or when a
 * worker hangs. Before it exits, it closes the healthy workers as {@link Server.close} does. When
 * your code calls `process.exit()`, the main thread waits up to 5 seconds until each worker closes
 * its connections.
 *
 * @param options - You choose the app, the address, the certificates, and the worker threads here.
 * @returns The promise resolves to the server once the server listens.
 * @throws {@link UhttpError} with the code `INVALID_SERVE_OPTIONS` when an option has the wrong type
 * or a value outside its range, or when you pass options that the package can't use together. It
 * throws the code `INVALID_CERTIFICATE` when the package fails to load a key file or a certificate
 * file, or when a key fails to decrypt or to match its certificate. It throws the code
 * `APP_START_FAILED` when the app module fails to build the app or a worker crashes during the
 * start. It throws the code `LISTEN_FAILED` when the operating system fails to bind the address, or
 * when a file other than a socket, or a socket on which a server listens, is at the Unix socket path.
 */
export async function serve(options: ServeOptions): Promise<Server> {
  const checked = checkedServeOptions(options)
  const uws = loadUws()
  if (checked.threads === 0) return serveOnMainThread(uws, checked)
  if (!(checked.app instanceof URL)) {
    throw new UhttpError('INVALID_SERVE_OPTIONS', 'With threads, pass the URL of the app module as the app option.')
  }
  return serveOnWorkers(uws, checked, checked.app)
}
