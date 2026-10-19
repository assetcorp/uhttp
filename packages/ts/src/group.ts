import type { GuardRecord, RegistryContents, RouteRecord, WebSocketRecord } from './compile.js'
import { UhttpError } from './errors.js'
import { checkedLimit, checkedTimeLimit } from './limits.js'
import { joinPath, Matcher, parseGroupPrefix, parseRoutePath } from './router/index.js'
import type { Handler, Middleware, RouteArguments, RouteOptions } from './types.js'
import { checkedWebSocketRoute, isWebSocketRoute } from './websocket/route.js'
import type { WebSocketArguments } from './websocket/types.js'

const WEBSOCKET_SHAPE = 'WEBSOCKET'

/**
 * The app and its groups share this record of everything that you added.
 *
 * @internal
 */
export class Registry implements RegistryContents {
  /** You added this middleware to the app itself. */
  readonly middleware: Middleware[] = []
  /** You added these groups, in this order. */
  readonly guards: GuardRecord[] = []
  /** You added these routes, in this order. */
  readonly routes: RouteRecord[] = []
  /** You added these WebSocket routes, in this order. */
  readonly webSockets: WebSocketRecord[] = []
  /** The registry counts every change, so that the app can rebuild its startup form after one. */
  version = 0
  readonly #shapes = new Matcher<true>()

  /**
   * Records a route after checking that its method has no route of the same shape.
   *
   * @param record - The package passes the route to record.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` when the method already has a route of
   * the same shape.
   */
  addRoute(record: RouteRecord): void {
    if (!this.#shapes.add(record.method, record.segments, true)) {
      throw new UhttpError(
        'INVALID_ROUTE',
        `You have already added a ${record.method} route of the same shape as '${record.path}'.`,
      )
    }
    this.routes.push(record)
    this.version++
  }

  /**
   * Records a WebSocket route once the method has checked that no other WebSocket route has the
   * same shape.
   *
   * @param record - The package passes the WebSocket route to record.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` when a WebSocket route of the same
   * shape exists.
   */
  addWebSocket(record: WebSocketRecord): void {
    if (!this.#shapes.add(WEBSOCKET_SHAPE, record.segments, true)) {
      throw new UhttpError(
        'INVALID_ROUTE',
        `You have already added a WebSocket route of the same shape as '${record.path}'.`,
      )
    }
    this.webSockets.push(record)
    this.version++
  }
}

interface GroupState {
  readonly registry: Registry
  readonly prefix: string
  readonly guard: GuardRecord | undefined
}

const states = new WeakMap<Group, GroupState>()

function stateOf(group: Group): GroupState {
  const state = states.get(group)
  if (state === undefined) throw new UhttpError('INVALID_ROUTE', 'Create a group through createApp() or group().')
  return state
}

function isMiddleware(value: unknown): value is Middleware {
  if (typeof value === 'function') return true
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'before') === 'function' || typeof Reflect.get(value, 'handle') === 'function'
}

function checkMiddlewareFunctions(value: object): void {
  for (const name of ['before', 'handle']) {
    const entry: unknown = Reflect.get(value, name)
    if (entry !== undefined && typeof entry !== 'function') {
      throw new UhttpError('INVALID_ROUTE', `Set the ${name} of a middleware to a function, or leave it out.`)
    }
  }
}

function checkDeclarations(value: object, owner: string, allowAll: boolean): void {
  const headers: unknown = Reflect.get(value, 'headers')
  const isList = Array.isArray(headers) && headers.every(name => typeof name === 'string')
  if (headers !== undefined && !isList && !(allowAll && headers === 'all')) {
    const choices = allowAll ? "a list of header names or 'all'" : 'a list of header names'
    throw new UhttpError('INVALID_ROUTE', `Set the headers of ${owner} to ${choices}.`)
  }
  const clientAddress: unknown = Reflect.get(value, 'clientAddress')
  if (clientAddress !== undefined && typeof clientAddress !== 'boolean') {
    throw new UhttpError('INVALID_ROUTE', `Set the clientAddress of ${owner} to true or false.`)
  }
}

function checkOptionsHeaders(value: object): void {
  const headers: unknown = Reflect.get(value, 'optionsHeaders')
  if (headers === undefined) return
  if (!Array.isArray(headers) || !headers.every(name => typeof name === 'string')) {
    throw new UhttpError('INVALID_ROUTE', 'Set the optionsHeaders of a middleware to a list of header names.')
  }
}

function checkedMiddleware(list: readonly unknown[]): Middleware[] {
  return list.map(entry => {
    if (typeof entry === 'object' && entry !== null) checkMiddlewareFunctions(entry)
    if (!isMiddleware(entry)) {
      throw new UhttpError(
        'INVALID_ROUTE',
        'Pass each middleware as a function or as an object with a before function, a handle function, or both.',
      )
    }
    if (typeof entry !== 'function') {
      checkDeclarations(entry, 'a middleware', false)
      checkOptionsHeaders(entry)
    }
    return entry
  })
}

function isHandler(value: unknown): value is Handler {
  return typeof value === 'function'
}

function checkRouteLimits(value: object): void {
  const body: unknown = Reflect.get(value, 'body')
  if (body !== undefined && typeof body !== 'boolean') {
    throw new UhttpError('INVALID_ROUTE', 'Set the body of a route to true or false.')
  }
  const maxBodyBytes: unknown = Reflect.get(value, 'maxBodyBytes')
  if (maxBodyBytes !== undefined) checkedLimit(maxBodyBytes, 'INVALID_ROUTE', 'maxBodyBytes')
  const timeoutMs: unknown = Reflect.get(value, 'timeoutMs')
  if (timeoutMs !== undefined) checkedTimeLimit(timeoutMs, 'INVALID_ROUTE')
}

function hasMiddlewareKey(value: object): boolean {
  return Reflect.has(value, 'before') || Reflect.has(value, 'handle')
}

function isRouteOptions(value: unknown): value is RouteOptions {
  if (typeof value !== 'object' || value === null || hasMiddlewareKey(value)) return false
  checkDeclarations(value, 'a route', true)
  checkRouteLimits(value)
  return true
}

function splitStack(stack: readonly unknown[]): { options: RouteOptions[]; middleware: Middleware[] } {
  const options: RouteOptions[] = []
  const middleware: unknown[] = []
  for (const entry of stack) {
    if (isRouteOptions(entry)) options.push(entry)
    else middleware.push(entry)
  }
  return { options, middleware: checkedMiddleware(middleware) }
}

function splitArguments(args: RouteArguments): { options: RouteOptions[]; middleware: Middleware[]; handler: Handler } {
  const handler: unknown = args.at(-1)
  if (!isHandler(handler)) throw new UhttpError('INVALID_ROUTE', 'Pass the handler of a route last.')
  return { ...splitStack(args.slice(0, -1)), handler }
}

function checkWebSocketOptions(options: readonly RouteOptions[]): void {
  for (const entry of options) {
    if (entry.body !== undefined || entry.maxBodyBytes !== undefined) {
      throw new UhttpError(
        'INVALID_ROUTE',
        'Leave body and maxBodyBytes out of the options of a WebSocket route, because the package reads no body for an upgrade request.',
      )
    }
  }
}

/**
 * Attaches the shared record and the prefix to a new app or group.
 *
 * @param group - The package passes the new app or group.
 * @param registry - The package passes the record that the app and its groups share.
 * @param prefix - The package passes the whole prefix, which is `/` for the app.
 * @param guard - The package passes the guard record of the group, and it is `undefined` for the app.
 * @internal
 */
export function attachGroup(group: Group, registry: Registry, prefix: string, guard: GuardRecord | undefined): void {
  states.set(group, { registry, prefix, guard })
}

/**
 * Returns the record that an app and its groups share.
 *
 * @param group - The package passes the app or one of its groups.
 * @returns The function returns the shared record.
 * @internal
 */
export function registryOf(group: Group): Registry {
  return stateOf(group).registry
}

/**
 * You get a `Group` from {@link Group.group}. Its middleware wraps every request whose raw path
 * starts with the group prefix, segment by segment, including a 404 or a 405 under the prefix.
 */
export class Group {
  /** Only the package creates a group. */
  protected constructor() {}

  /**
   * Adds middleware to this group, or to the whole app when you call the method on the app. The
   * package applies the middleware to every route, whether you added the route before or after.
   *
   * @param middleware - The middleware wraps the request in the order in which you pass it.
   * @returns The method returns this group, so that you can chain another call.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` when an entry is not a middleware.
   */
  use(...middleware: Middleware[]): this {
    const { registry, guard } = stateOf(this)
    const checked = checkedMiddleware(middleware)
    if (guard === undefined) registry.middleware.push(...checked)
    else guard.middleware.push(...checked)
    registry.version++
    return this
  }

  /**
   * Returns a group of routes under a path prefix, with its own middleware.
   *
   * @param prefix - The prefix must start with `/` and end without `/`, and it can contain `:name`
   * parameters.
   * @param middleware - The package applies this middleware to every request under the prefix.
   * @returns The method returns the new group.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` when the prefix breaks the rules of the
   * router or when an entry is not a middleware.
   */
  group(prefix: string, ...middleware: Middleware[]): Group {
    const { registry, prefix: parent } = stateOf(this)
    parseGroupPrefix(prefix)
    const whole = joinPath(parent, prefix)
    const guard: GuardRecord = { segments: parseGroupPrefix(whole), middleware: checkedMiddleware(middleware) }
    registry.guards.push(guard)
    registry.version++
    const group = new Group()
    attachGroup(group, registry, whole, guard)
    return group
  }

  /**
   * Adds a route for GET requests. For a HEAD request to the same path, the package sends the
   * headers of the GET reply with no body.
   *
   * @param path - The path must start with `/`, and its segments must be static text or `:name`
   * parameters. The router matches the path exactly and with its case, so `/users` and `/users/`
   * are two routes.
   * @param args - You pass any middleware for this route alone and any {@link RouteOptions}, and you
   * pass the handler last.
   * @returns The method returns this group, so that you can chain another route.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` when the path breaks the rules of the
   * router, when the method already has a route of the same shape, or when a route option has the
   * wrong type.
   */
  get(path: string, ...args: RouteArguments): this {
    return this.#add('GET', path, args)
  }

  /**
   * Adds a route for POST requests.
   *
   * @param path - The rules of {@link Group.get} apply to the path.
   * @param args - You pass any middleware for this route alone and any {@link RouteOptions}, and you
   * pass the handler last.
   * @returns The method returns this group, so that you can chain another route.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` in the same cases as {@link Group.get}.
   */
  post(path: string, ...args: RouteArguments): this {
    return this.#add('POST', path, args)
  }

  /**
   * Adds a route for PUT requests.
   *
   * @param path - The rules of {@link Group.get} apply to the path.
   * @param args - You pass any middleware for this route alone and any {@link RouteOptions}, and you
   * pass the handler last.
   * @returns The method returns this group, so that you can chain another route.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` in the same cases as {@link Group.get}.
   */
  put(path: string, ...args: RouteArguments): this {
    return this.#add('PUT', path, args)
  }

  /**
   * Adds a route for PATCH requests.
   *
   * @param path - The rules of {@link Group.get} apply to the path.
   * @param args - You pass any middleware for this route alone and any {@link RouteOptions}, and you
   * pass the handler last.
   * @returns The method returns this group, so that you can chain another route.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` in the same cases as {@link Group.get}.
   */
  patch(path: string, ...args: RouteArguments): this {
    return this.#add('PATCH', path, args)
  }

  /**
   * Adds a route for DELETE requests.
   *
   * @param path - The rules of {@link Group.get} apply to the path.
   * @param args - You pass any middleware for this route alone and any {@link RouteOptions}, and you
   * pass the handler last.
   * @returns The method returns this group, so that you can chain another route.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` in the same cases as {@link Group.get}.
   */
  delete(path: string, ...args: RouteArguments): this {
    return this.#add('DELETE', path, args)
  }

  /**
   * Adds a route for OPTIONS requests. The package calls this route in place of sending the
   * `Allow` list that it sends by default.
   *
   * @param path - The rules of {@link Group.get} apply to the path.
   * @param args - You pass any middleware for this route alone and any {@link RouteOptions}, and you
   * pass the handler last.
   * @returns The method returns this group, so that you can chain another route.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` in the same cases as {@link Group.get}.
   */
  options(path: string, ...args: RouteArguments): this {
    return this.#add('OPTIONS', path, args)
  }

  /**
   * Adds a WebSocket route. The package passes an upgrade request through the middleware of the
   * app, of each matching group, and of the route, so that a middleware can refuse the upgrade with
   * its own reply. The package copies the values that your middleware stores with
   * {@link Context.set} into the `data` of the socket. When a GET request to the same path asks for
   * no upgrade, the package answers with a 426, unless you add a GET route to that path.
   *
   * @typeParam Data - You declare the shape of the values that your middleware stores during the upgrade.
   * @param path - The rules of {@link Group.get} apply to the path.
   * @param args - You pass any middleware for this route alone and any {@link RouteOptions}, and you
   * pass the {@link WebSocketRoute} last.
   * @returns The method returns this group, so that you can chain another route.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` when the path breaks the rules of the
   * router, when a WebSocket route of the same shape exists, when the options set `body` or
   * `maxBodyBytes`, or when a handler or a limit of the route has the wrong type or a value outside
   * its range.
   */
  ws<Data extends object = Record<string, unknown>>(path: string, ...args: WebSocketArguments<Data>): this {
    const { registry, prefix } = stateOf(this)
    parseRoutePath(path)
    const whole = joinPath(prefix, path)
    const route: unknown = args.at(-1)
    if (!isWebSocketRoute(route)) {
      throw new UhttpError('INVALID_ROUTE', 'Pass the handlers and limits of a WebSocket route last, as an object.')
    }
    const { options, middleware } = splitStack(args.slice(0, -1))
    checkWebSocketOptions(options)
    const checked = checkedWebSocketRoute(route)
    registry.addWebSocket({ path: whole, segments: parseRoutePath(whole), options, middleware, route: checked })
    return this
  }

  #add(method: string, path: string, args: RouteArguments): this {
    const { registry, prefix } = stateOf(this)
    parseRoutePath(path)
    const whole = joinPath(prefix, path)
    const { options, middleware, handler } = splitArguments(args)
    registry.addRoute({ method, path: whole, segments: parseRoutePath(whole), options, middleware, handler })
    return this
  }
}
