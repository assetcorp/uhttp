import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js'
import { createRequire } from 'node:module'
import { type CompiledApp, headRouteOf } from '../compile.js'
import { PUBSUB_ORIGIN_BYTES } from '../constants.js'
import { UhttpError } from '../errors.js'
import type { Drain } from '../native/drain.js'
import { fallbackHandler, routeHandler } from '../native/index.js'
import type { Hub } from '../websocket/hub.js'
import type { CheckedTls } from './tls-options.js'

/**
 * The package loads uWebSockets.js in this shape.
 *
 * @internal
 */
export type Uws = typeof import('uWebSockets.js')

/**
 * Returns uWebSockets.js, which the package loads through `require`, because the ESM entry of
 * v20.71.0 imports a file that is missing from the tag.
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

/**
 * Returns the hub of a thread, which publishes the messages of every socket. The package loads the
 * code of WebSockets and pub/sub only for an app that has a WebSocket route or a pub/sub adapter.
 *
 * @param native - The package passes the app of uWebSockets.js on this thread.
 * @param app - The package passes the compiled app.
 * @param origin - The package passes the bytes that identify this process to a pub/sub adapter.
 * @returns The promise resolves to the hub, or to `undefined` for an app without WebSocket routes
 * or a pub/sub adapter.
 * @internal
 */
export async function hubOf(native: TemplatedApp, app: CompiledApp, origin: Uint8Array): Promise<Hub | undefined> {
  if (app.webSockets.length === 0 && app.runtime.pubsub === undefined) return undefined
  const { Hub } = await import('../websocket/hub.js')
  return new Hub(native, origin, app.runtime.pubsub, app.runtime.logger)
}

/**
 * Registers every route of an app with uWebSockets.js: each WebSocket route under `ws()`, each
 * route of the app with a HEAD route beside every GET route, and the fallback under `any('/*')`.
 * uWebSockets.js picks the routes of a request by the hostname that the client names in TLS, so the
 * function registers the whole table once more under each hostname.
 *
 * @param uws - The package passes the module of uWebSockets.js.
 * @param native - The package passes the app of uWebSockets.js on this thread.
 * @param app - The package passes the compiled app.
 * @param hub - The package passes the hub of the thread, or `undefined` when the app has none.
 * @param drain - The package passes the drain of the app of uWebSockets.js.
 * @param tls - The package passes the checked `tls` option, whose hostnames each get the whole table,
 * or `undefined` for a plain app.
 * @internal
 */
export async function registerApp(
  uws: Uws,
  native: TemplatedApp,
  app: CompiledApp,
  hub: Hub | undefined,
  drain: Drain,
  tls: CheckedTls | undefined,
): Promise<void> {
  const behaviorOf =
    hub !== undefined && app.webSockets.length > 0
      ? (await import('../websocket/behavior.js')).socketBehavior
      : undefined
  const register = (): void => {
    if (hub !== undefined && behaviorOf !== undefined) {
      for (const socket of app.webSockets) native.ws(socket.upgrade.path, behaviorOf(uws, app, socket, hub, drain))
    }
    for (const route of app.routes) {
      registrarOf(native, route.method)(route.path, routeHandler(app, route, route.method, drain))
      if (route.method !== 'GET') continue
      registrarOf(native, 'HEAD')(route.path, routeHandler(app, headRouteOf(route), 'HEAD', drain))
    }
    native.any('/*', fallbackHandler(app, drain))
  }
  register()
  for (const [hostname] of tls?.hostnames ?? []) {
    native.domain(hostname)
    register()
  }
}

/**
 * Returns a new app of uWebSockets.js for one thread, which serves HTTPS with `tls` once the
 * package has checked every key file and every certificate file, or plain HTTP without `tls`. The
 * package loads the code of TLS only for a server with `tls`.
 *
 * @param uws - The package passes the module of uWebSockets.js.
 * @param tls - The package passes the checked `tls` option, or `undefined` for plain HTTP.
 * @param withHostnames - The package passes `false` for the app that only accepts connections and
 * passes them to other apps.
 * @returns The promise resolves to the app, on which the package has registered no route.
 * @throws {@link UhttpError} with the code `INVALID_CERTIFICATE` when the package can't use a key
 * file or a certificate file.
 * @internal
 */
export async function nativeAppOf(
  uws: Uws,
  tls: CheckedTls | undefined,
  withHostnames: boolean,
): Promise<TemplatedApp> {
  if (tls === undefined) return uws.App()
  const { checkCertificates, secureApp } = await import('./tls.js')
  await checkCertificates(tls)
  return secureApp(uws, tls, withHostnames)
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
