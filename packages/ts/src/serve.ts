import type { HttpRequest, HttpResponse, TemplatedApp, us_listen_socket } from 'uWebSockets.js'
import { createRequire } from 'node:module'
import { type App, compiledOf } from './app.js'
import { type CompiledApp, headRouteOf } from './compile.js'
import { MAX_PORT, MIN_PORT } from './constants.js'
import { UhttpError } from './errors.js'
import { fallbackHandler, routeHandler } from './native/index.js'

type Uws = typeof import('uWebSockets.js')

/**
 * You pass these options to {@link serve} to choose the app, the port, and the host.
 */
export interface ServeOptions {
  /** You pass the app from {@link createApp} here. */
  app: App
  /**
   * The port must be a whole number from 0 to 65535, and with port 0 the operating system
   * assigns a free port.
   */
  port: number
  /**
   * The server listens on this address, such as `127.0.0.1`, and it listens on every interface
   * when you leave the address out.
   */
  host?: string
}

/**
 * You get a `Server` from {@link serve}, and you can find its port or close it through this
 * object.
 */
export interface Server {
  /** The server listens on this port, which the operating system assigns when you pass port 0. */
  readonly port: number
  /**
   * Closes the listening socket and every open connection.
   *
   * @returns The promise settles once the server has closed, and a second call returns the same
   * promise.
   */
  close(): Promise<void>
}

function loadUws(): Uws {
  return createRequire(import.meta.url)('uWebSockets.js') as Uws
}

type Register = (pattern: string, handler: (res: HttpResponse, req: HttpRequest) => void) => TemplatedApp

function registrarOf(native: TemplatedApp, method: string): Register {
  switch (method) {
    case 'GET':
      return native.get.bind(native)
    case 'HEAD':
      return native.head.bind(native)
    case 'POST':
      return native.post.bind(native)
    case 'PUT':
      return native.put.bind(native)
    case 'PATCH':
      return native.patch.bind(native)
    case 'DELETE':
      return native.del.bind(native)
    case 'OPTIONS':
      return native.options.bind(native)
    default:
      throw new UhttpError(
        'INVALID_ROUTE',
        `The package can register no uWebSockets.js route for the method ${method}.`,
      )
  }
}

function registerRoutes(native: TemplatedApp, app: CompiledApp): void {
  for (const route of app.routes) {
    registrarOf(native, route.method)(route.path, routeHandler(app, route, route.method))
    if (route.method === 'GET') registrarOf(native, 'HEAD')(route.path, routeHandler(app, headRouteOf(route), 'HEAD'))
  }
  native.any('/*', fallbackHandler(app))
}

function listen(native: TemplatedApp, port: number, host: string | undefined): Promise<us_listen_socket> {
  return new Promise((resolve, reject) => {
    const onListen = (listenSocket: us_listen_socket | false): void => {
      if (listenSocket) {
        resolve(listenSocket)
        return
      }
      native.close()
      reject(
        new UhttpError(
          'LISTEN_FAILED',
          `The operating system could not bind ${host ?? 'every interface'} on port ${port}.`,
        ),
      )
    }
    if (host === undefined) {
      native.listen(port, onListen)
      return
    }
    native.listen(host, port, onListen)
  })
}

async function closeServer(uws: Uws, native: TemplatedApp, listenSocket: us_listen_socket): Promise<void> {
  uws.us_listen_socket_close(listenSocket)
  native.close()
}

/**
 * Returns a server that listens on the host and the port that you choose, once the package has
 * registered the routes of the app with uWebSockets.js.
 *
 * @param options - You choose the app, the port, and the host here.
 * @returns The promise resolves to the server once the server listens.
 * @throws {@link UhttpError} with the code `INVALID_SERVE_OPTIONS` when the port is a fraction,
 * below 0, or above 65535, and with the code `LISTEN_FAILED` when the operating system can't bind
 * the address.
 */
export async function serve(options: ServeOptions): Promise<Server> {
  const { app, port, host } = options
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new UhttpError(
      'INVALID_SERVE_OPTIONS',
      `The port must be a whole number from ${MIN_PORT} to ${MAX_PORT}, and you passed ${port}.`,
    )
  }
  const compiled = compiledOf(app)
  const uws = loadUws()
  const native = uws.App()
  registerRoutes(native, compiled)
  const listenSocket = await listen(native, port, host)
  let closing: Promise<void> | undefined
  return {
    port: uws.us_socket_local_port(listenSocket),
    close() {
      closing ??= closeServer(uws, native, listenSocket)
      return closing
    },
  }
}
