import { Context, type Handler, notFound, type Reply, respond, sendsBody } from './context.js'
import { UhttpError } from './errors.js'

const STATIC_PATH = /^\/[^:*?#]*$/

/**
 * You pass these settings to {@link App.request}, which sends a request through the app without
 * a network.
 */
export interface TestRequestInit {
  /** When you leave out the method, {@link App.request} sends a `GET`. */
  method?: string
}

let readRoutes: (app: App) => ReadonlyMap<string, Handler>

/**
 * You get an `App` from {@link createApp} and add routes to it. You can then pass the app to
 * {@link serve} to put it on the network, or you can call {@link App.request} to test it without
 * a network.
 */
export class App {
  readonly #routes = new Map<string, Handler>()

  static {
    readRoutes = app => app.#routes
  }

  /**
   * Adds a route for GET requests to one path and returns the app, so that you can chain another
   * route.
   *
   * @param path - The path must start with `/`, and it must contain none of `:`, `*`, `?`, and
   * `#`. The router matches the path exactly, including its case.
   * @param handler - The package calls this handler for every GET request to the path.
   * @returns The method returns the app, so that you can chain another route.
   * @throws {@link UhttpError} with the code `INVALID_ROUTE` when the path starts with a character
   * other than `/` or contains one of those four characters, and when you have already added a
   * GET route for the path.
   */
  get(path: string, handler: Handler): this {
    if (!STATIC_PATH.test(path)) {
      throw new UhttpError(
        'INVALID_ROUTE',
        `The route path '${path}' must start with '/', and it must contain none of ':', '*', '?', and '#'.`,
      )
    }
    if (this.#routes.has(path)) {
      throw new UhttpError('INVALID_ROUTE', `You have already added a GET route for '${path}'.`)
    }
    this.#routes.set(path, handler)
    return this
  }

  /**
   * Returns the response that a client on the network receives for the same request, without
   * opening a port, so that your test can check a route with no network.
   *
   * @param target - The target is the path with an optional query string, such as
   * `/search?q=uhttp`.
   * @param init - You can set the method of the request here.
   * @returns The promise resolves to a response with the status, the headers that the app sets,
   * and the body.
   */
  async request(target: string, init: TestRequestInit = {}): Promise<Response> {
    const queryStart = target.indexOf('?')
    const path = queryStart === -1 ? target : target.slice(0, queryStart)
    const query = queryStart === -1 ? '' : target.slice(queryStart + 1)
    const method = init.method ?? 'GET'
    const handler = method === 'GET' ? this.#routes.get(path) : undefined
    const reply = await respond(handler ?? notFound, new Context(method, path, query))
    return toResponse(reply)
  }
}

function toResponse(reply: Reply): Response {
  const body = sendsBody(reply) ? reply.body : null
  return new Response(body, { status: reply.status, headers: { 'content-type': reply.contentType } })
}

/**
 * Returns the handler of every GET route in an app, keyed by path, in the order that you added
 * the routes.
 *
 * @param app - The function lists the routes of this app.
 * @returns The function returns a map from each path to its handler.
 * @internal
 */
export function routesOf(app: App): ReadonlyMap<string, Handler> {
  return readRoutes(app)
}

/**
 * Returns a new app with no routes, so that you can add routes before you pass the app to
 * {@link serve}.
 *
 * @returns The function returns the new app.
 */
export function createApp(): App {
  return new App()
}
