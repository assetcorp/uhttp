import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js'
import { createRequire } from 'node:module'
import { type CompiledApp, headRouteOf } from '../compile.js'
import { PUBSUB_ORIGIN_BYTES } from '../constants.js'
import { UhttpError } from '../errors.js'
import { fallbackHandler, routeHandler } from '../native/index.js'
import type { Hub } from '../websocket/hub.js'

/**
 * The package loads uWebSockets.js in this shape.
 *
 * @internal
 */
export type Uws = typeof import('uWebSockets.js')

/**
 * Returns uWebSockets.js, which the package loads through `require`, because the ESM entry of
 * v20.71.0 imports a file that the tag lacks.
 *
 * @returns The function returns the module of uWebSockets.js.
 * @internal
 */
export function loadUws(): Uws {
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

async function hubOf(native: TemplatedApp, app: CompiledApp, origin: Uint8Array): Promise<Hub | undefined> {
  if (app.webSockets.length === 0 && app.runtime.pubsub === undefined) return undefined
  const { Hub } = await import('../websocket/hub.js')
  return new Hub(native, origin, app.runtime.pubsub, app.runtime.logger)
}

/**
 * Registers every route of an app with uWebSockets.js: each WebSocket route under `ws()`, each
 * route of the app with a HEAD route beside every GET route, and the fallback under `any('/*')`.
 * The package loads the code of WebSockets and pub/sub only for an app that has a WebSocket route
 * or a pub/sub adapter.
 *
 * @param uws - The package passes the module of uWebSockets.js.
 * @param native - The package passes the app of uWebSockets.js on this thread.
 * @param app - The package passes the compiled app.
 * @param origin - The package passes the bytes that identify this process to a pub/sub adapter.
 * @returns The promise resolves to the hub of the thread, through which every socket publishes, or
 * to `undefined` for an app without WebSocket routes or a pub/sub adapter.
 * @internal
 */
export async function registerApp(
  uws: Uws,
  native: TemplatedApp,
  app: CompiledApp,
  origin: Uint8Array,
): Promise<Hub | undefined> {
  const hub = await hubOf(native, app, origin)
  if (hub !== undefined && app.webSockets.length > 0) {
    const { socketBehavior } = await import('../websocket/behavior.js')
    for (const socket of app.webSockets) native.ws(socket.upgrade.path, socketBehavior(uws, app, socket, hub))
  }
  for (const route of app.routes) {
    registrarOf(native, route.method)(route.path, routeHandler(app, route, route.method))
    if (route.method === 'GET') registrarOf(native, 'HEAD')(route.path, routeHandler(app, headRouteOf(route), 'HEAD'))
  }
  native.any('/*', fallbackHandler(app))
  return hub
}

/**
 * Returns random bytes that identify this process to a pub/sub adapter.
 *
 * @returns The function returns new bytes on every call.
 * @internal
 */
export function processOrigin(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(PUBSUB_ORIGIN_BYTES))
}
