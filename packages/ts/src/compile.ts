import { ALLOW_METHOD_ORDER, BODY_METHODS, LIST_HEADER_NAMES } from './constants.js'
import type { AppRuntime } from './exchange.js'
import { Matcher, prefixCoverage, prefixMatches, type Segment, splitPath } from './router/index.js'
import type { Handler, Middleware, MiddlewareHandler, RouteOptions } from './types.js'
import { upgradeRequired } from './websocket/handshake.js'
import type { CheckedWebSocketRoute } from './websocket/route.js'

/**
 * The package records each route in this form when you add it.
 *
 * @internal
 */
export interface RouteRecord {
  /** The route matches requests with this method, which is in upper case. */
  readonly method: string
  /** The package matches this whole path, which starts with the group prefix. */
  readonly path: string
  /** The package split the whole path into these segments. */
  readonly segments: readonly Segment[]
  /** You passed these options objects to the route. */
  readonly options: readonly RouteOptions[]
  /** You passed this middleware to the route alone. */
  readonly middleware: readonly Middleware[]
  /** The package calls this handler at the end of the chain. */
  readonly handler: Handler
}

/**
 * The package records each group in this form, as a prefix guard whose middleware wraps every
 * request whose raw path starts with the prefix.
 *
 * @internal
 */
export interface GuardRecord {
  /** The package split the whole prefix into these segments. */
  readonly segments: readonly Segment[]
  /** You added this middleware to the group, and the list grows each time that you call `use` on the group. */
  readonly middleware: Middleware[]
}

/**
 * The app and its groups record everything that you add in this form.
 *
 * @internal
 */
export interface RegistryContents {
  /** You added this middleware to the app itself. */
  readonly middleware: readonly Middleware[]
  /** You added these groups, in this order. */
  readonly guards: readonly GuardRecord[]
  /** You added these routes, in this order. */
  readonly routes: readonly RouteRecord[]
  /** You added these WebSocket routes, in this order. */
  readonly webSockets: readonly WebSocketRecord[]
}

/**
 * The package records each WebSocket route in this form when you add it.
 *
 * @internal
 */
export interface WebSocketRecord {
  /** The package matches this whole path, which starts with the group prefix. */
  readonly path: string
  /** The package split the whole path into these segments. */
  readonly segments: readonly Segment[]
  /** You passed these options objects to the route. */
  readonly options: readonly RouteOptions[]
  /** You passed this middleware to the route alone. */
  readonly middleware: readonly Middleware[]
  /** The package checked the handlers and the limits of the route into this form. */
  readonly route: CheckedWebSocketRoute
}

/**
 * The package builds this form of each WebSocket route at startup.
 *
 * @internal
 */
export interface CompiledWebSocket {
  /**
   * The upgrade request passes through the chain of this GET route, whose handler answers 426 to a
   * request without an upgrade.
   */
  readonly upgrade: CompiledRoute
  /** The package applies these handlers and limits to every socket of the route. */
  readonly route: CheckedWebSocketRoute
}

/**
 * The package follows this plan when it copies the parts of a request that a chain declared.
 *
 * @internal
 */
export interface CopyPlan {
  /** The chain declared these header names, which the package lowercased. */
  readonly headerNames: readonly string[]
  /** For each declared name, this is `true` when the package collects every line of the header. */
  readonly listHeaders: readonly boolean[]
  /** This is `true` when at least one declared header is a list header. */
  readonly hasListHeader: boolean
  /** This is `true` when the package copies every header of the request. */
  readonly allHeaders: boolean
  /** This is `true` when the package copies the client address. */
  readonly clientAddress: boolean
}

/**
 * The package builds this form of each route at startup.
 *
 * @internal
 */
export interface CompiledRoute {
  /** The route matches requests with this method. */
  readonly method: string
  /** The package registers this whole path with uWebSockets.js, which shares its syntax. */
  readonly path: string
  /** You wrote these parameter names in the route path, in this order. */
  readonly parameterNames: readonly string[]
  /** The package calls this middleware in order: app, group, then route. */
  readonly layers: readonly MiddlewareHandler[]
  /** The package calls this handler at the end of the chain. */
  readonly handler: Handler
  /** The package copies the request for the route by this plan. */
  readonly copyPlan: CopyPlan
  /** The package reads the body reader, the body limit, and the time limit of the route from these limits. */
  readonly limits: RouteLimits
}

/**
 * The package applies these limits to each request of a route.
 *
 * @internal
 */
export interface RouteLimits {
  /** This is `true` when the package attaches a body reader for the route. */
  readonly readsBody: boolean
  /** The package accepts a body of up to this many bytes. */
  readonly maxBodyBytes: number
  /** A handler has this many milliseconds before the package sends a 503, and 0 means no limit. */
  readonly timeoutMs: number
}

/**
 * The package builds this form of each prefix guard at startup.
 *
 * @internal
 */
export interface CompiledGuard {
  /** The package split the prefix into these segments. */
  readonly segments: readonly Segment[]
  /** You added this middleware to the group. */
  readonly middleware: readonly Middleware[]
}

/**
 * The package builds this form of an app at startup.
 *
 * @internal
 */
export interface CompiledApp {
  /** Every request to the app shares these settings. */
  readonly runtime: AppRuntime
  /**
   * You added these routes, together with a GET route for each WebSocket route whose path has no
   * GET route of the same shape, and the list leaves out the HEAD routes that the package adds.
   */
  readonly routes: readonly CompiledRoute[]
  /** You added these WebSocket routes, in this order. */
  readonly webSockets: readonly CompiledWebSocket[]
  /** This matcher has every WebSocket route under the method `GET`. */
  readonly upgradeMatcher: Matcher<CompiledWebSocket>
  /** The JavaScript matcher has every route, with a HEAD route beside every GET route. */
  readonly matcher: Matcher<CompiledRoute>
  /** At least one route uses each of these methods, which follow the order of the `Allow` header. */
  readonly methods: readonly string[]
  /** You added this middleware to the app itself. */
  readonly appMiddleware: readonly Middleware[]
  /** The package calls the middleware of the app through these functions. */
  readonly appLayers: readonly MiddlewareHandler[]
  /** The package copies a request by this plan when only the middleware of the app wraps it. */
  readonly appCopyPlan: CopyPlan
  /** A request that no route handles has these limits, which are those of the app with no body reader. */
  readonly appLimits: RouteLimits
  /** The package checks these prefix guards from the shortest prefix to the longest. */
  readonly guards: readonly CompiledGuard[]
}

/**
 * Returns the function form of a middleware.
 *
 * @param middleware - You pass a middleware function or a middleware definition.
 * @returns The function returns a function that calls the middleware.
 * @internal
 */
export function handlerOf(middleware: Middleware): MiddlewareHandler {
  if (typeof middleware === 'function') return middleware
  return (context, next) => middleware.handle(context, next)
}

function guarded(segments: readonly Segment[], middleware: Middleware): MiddlewareHandler {
  const handle = handlerOf(middleware)
  return (context, next) => (prefixMatches(segments, splitPath(context.req.path)) ? handle(context, next) : next())
}

/**
 * Returns the plan by which the package copies a request for a chain of middleware and a route.
 *
 * @param middleware - You pass every middleware in the chain.
 * @param options - You pass the options objects of the route, or none for a fallback answer.
 * @returns The function returns a plan that merges every declaration.
 * @internal
 */
export function copyPlanOf(middleware: readonly Middleware[], options: readonly RouteOptions[] = []): CopyPlan {
  const names = new Set<string>()
  let allHeaders = false
  let clientAddress = false
  const declare = (headers: readonly string[] | 'all' | undefined): void => {
    if (headers === 'all') {
      allHeaders = true
      return
    }
    for (const name of headers ?? []) names.add(name.toLowerCase())
  }
  for (const entry of options) {
    declare(entry.headers)
    if (entry.clientAddress === true) clientAddress = true
  }
  for (const entry of middleware) {
    if (typeof entry === 'function') continue
    declare(entry.headers)
    if (entry.clientAddress === true) clientAddress = true
  }
  const headerNames = [...names]
  const listHeaders = headerNames.map(name => LIST_HEADER_NAMES.includes(name))
  return { headerNames, listHeaders, hasListHeader: listHeaders.includes(true), allHeaders, clientAddress }
}

function routeLimitsOf(record: RouteRecord, runtime: AppRuntime): RouteLimits {
  let readsBody = BODY_METHODS.includes(record.method)
  let { maxBodyBytes, timeoutMs } = runtime
  for (const options of record.options) {
    if (options.body !== undefined) readsBody = options.body
    if (options.maxBodyBytes !== undefined) maxBodyBytes = options.maxBodyBytes
    if (options.timeoutMs !== undefined) timeoutMs = options.timeoutMs
  }
  return { readsBody, maxBodyBytes, timeoutMs }
}

function compileRoute(
  record: RouteRecord,
  appMiddleware: readonly Middleware[],
  guards: readonly CompiledGuard[],
  runtime: AppRuntime,
): CompiledRoute {
  const layers: MiddlewareHandler[] = appMiddleware.map(handlerOf)
  const declared: Middleware[] = [...appMiddleware]
  for (const guard of guards) {
    const coverage = prefixCoverage(guard.segments, record.segments)
    if (coverage === 'never') continue
    declared.push(...guard.middleware)
    for (const middleware of guard.middleware) {
      layers.push(coverage === 'always' ? handlerOf(middleware) : guarded(guard.segments, middleware))
    }
  }
  declared.push(...record.middleware)
  layers.push(...record.middleware.map(handlerOf))
  const parameterNames = record.segments.flatMap(segment => (segment.kind === 'parameter' ? [segment.name] : []))
  return {
    method: record.method,
    path: record.path,
    parameterNames,
    layers,
    handler: record.handler,
    copyPlan: copyPlanOf(declared, record.options),
    limits: routeLimitsOf(record, runtime),
  }
}

/**
 * Returns the HEAD route that the package adds beside a GET route. It shares the chain and the
 * limits of the GET route, apart from the body reader, which a HEAD request never needs.
 *
 * @param route - The package passes the compiled GET route.
 * @returns The function returns the HEAD route.
 * @internal
 */
export function headRouteOf(route: CompiledRoute): CompiledRoute {
  return { ...route, method: 'HEAD', limits: { ...route.limits, readsBody: false } }
}

function methodRank(method: string): number {
  const rank = ALLOW_METHOD_ORDER.indexOf(method)
  return rank === -1 ? ALLOW_METHOD_ORDER.length : rank
}

/**
 * Returns the startup form of an app. In that form, every route has its middleware chain in the
 * order app, group, then route, and the JavaScript matcher has a HEAD route beside every GET route.
 *
 * @param runtime - You pass the settings that every request to the app shares.
 * @param contents - You pass the middleware, the groups, and the routes that the app recorded.
 * @returns The function returns the compiled app.
 * @internal
 */
export function compileApp(runtime: AppRuntime, contents: RegistryContents): CompiledApp {
  const guards = contents.guards
    .filter(guard => guard.middleware.length > 0)
    .map(guard => ({ segments: guard.segments, middleware: [...guard.middleware] }))
    .sort((left, right) => left.segments.length - right.segments.length)
  const matcher = new Matcher<CompiledRoute>()
  const routes = contents.routes.map(record => {
    const route = compileRoute(record, contents.middleware, guards, runtime)
    matcher.add(route.method, record.segments, route)
    if (route.method === 'GET') matcher.add('HEAD', record.segments, headRouteOf(route))
    return route
  })
  const upgradeMatcher = new Matcher<CompiledWebSocket>()
  const webSockets = contents.webSockets.map(record => {
    const routeRecord: RouteRecord = { ...record, method: 'GET', handler: upgradeRequired }
    const upgrade = compileRoute(routeRecord, contents.middleware, guards, runtime)
    const socket: CompiledWebSocket = { upgrade, route: record.route }
    upgradeMatcher.add('GET', record.segments, socket)
    if (matcher.add('GET', record.segments, upgrade)) {
      matcher.add('HEAD', record.segments, headRouteOf(upgrade))
      routes.push(upgrade)
    }
    return socket
  })
  const methods = matcher.methods().sort((left, right) => methodRank(left) - methodRank(right))
  return {
    runtime,
    routes,
    webSockets,
    upgradeMatcher,
    matcher,
    methods,
    appMiddleware: [...contents.middleware],
    appLayers: contents.middleware.map(handlerOf),
    appCopyPlan: copyPlanOf(contents.middleware),
    appLimits: { readsBody: false, maxBodyBytes: runtime.maxBodyBytes, timeoutMs: runtime.timeoutMs },
    guards,
  }
}
