import { compiledOf, setPublisher } from '../app.js'
import { SERVICE_UNAVAILABLE_STATUS } from '../constants.js'
import { UhttpError } from '../errors.js'
import { headerBytes } from '../headers.js'
import { statusLine } from '../native/head.js'
import type { Hub } from '../websocket/hub.js'
import { type Listener, listenOn } from './listen.js'
import { importApp } from './module.js'
import { loadUws, processOrigin, registerApp, type Uws } from './native.js'
import { type CheckedServeOptions, checkedServeOptions, type ServeOptions } from './options.js'

export type { ServeOptions } from './options.js'

const NO_WORKER_STATUS = headerBytes(statusLine(SERVICE_UNAVAILABLE_STATUS))
const NO_WORKER_BODY = headerBytes('No worker thread can serve this request.')

/**
 * You get a `Server` from {@link serve}, and you can find its port or close it through this
 * object.
 */
export interface Server {
  /**
   * The server listens on this port, which the operating system assigns when you pass port 0. It
   * is `undefined` for a server on a Unix socket.
   */
  readonly port: number | undefined
  /**
   * Closes the listening socket, every open connection, and every worker thread.
   *
   * @returns The promise settles once the server has closed, and a second call returns the same
   * promise.
   */
  close(): Promise<void>
}

function serverOf(listener: Listener, close: () => Promise<void>): Server {
  let closing: Promise<void> | undefined
  return {
    port: listener.port,
    close() {
      closing ??= close()
      return closing
    },
  }
}

async function serveOnMainThread(uws: Uws, options: CheckedServeOptions): Promise<Server> {
  const app = options.app instanceof URL ? await importApp(options.app) : options.app
  const compiled = compiledOf(app)
  const native = uws.App()
  let started: Hub | undefined
  let listener: Listener
  try {
    started = await registerApp(uws, native, compiled, processOrigin())
    await started?.start()
    listener = await listenOn(uws, native, options.address)
  } catch (error) {
    await started?.close()
    native.close()
    throw error
  }
  const hub = started
  if (hub !== undefined) {
    setPublisher(app, (topic, message, publishOptions) => hub.publish(topic, message, publishOptions))
  }
  return serverOf(listener, async () => {
    setPublisher(app, undefined)
    await listener.close()
    await hub?.close()
    native.close()
  })
}

async function serveOnWorkers(uws: Uws, options: CheckedServeOptions, module: URL): Promise<Server> {
  const acceptor = uws.App()
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
  return serverOf(listener, async () => {
    await listener.close()
    await supervisor.stop()
    acceptor.close()
  })
}

/**
 * Returns a server that listens on the address that you choose, once the package has registered
 * the routes of the app with uWebSockets.js. With `threads`, each worker thread imports the module
 * at the URL that you pass and builds its own app, while the main thread accepts each connection
 * and hands it to a worker. The main thread replaces a worker that crashes, and the server exits
 * with an error when every worker is dead, when workers crash too often, or when a worker hangs.
 *
 * @param options - You choose the app, the address, and the worker threads here.
 * @returns The promise resolves to the server once the server listens.
 * @throws {@link UhttpError} with the code `INVALID_SERVE_OPTIONS` when an option is invalid or
 * the options combine in a way that the server can't serve, with the code `APP_START_FAILED` when
 * the app module fails to build the app, and with the code `LISTEN_FAILED` when the operating
 * system can't bind the address or another file or server holds the Unix socket path.
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
