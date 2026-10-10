import { type CompiledApp, compileApp } from './compile.js'
import { UhttpError } from './errors.js'
import type { AppRuntime } from './exchange.js'
import { attachGroup, Group, Registry, registryOf } from './group.js'
import type { TestRequestInit } from './testing/index.js'
import type { AppOptions } from './types.js'

let construct: (runtime: AppRuntime) => App
let compile: (app: App) => CompiledApp

function checkedRuntime(options: AppOptions): AppRuntime {
  const { logger, notFound, onError } = options
  if (logger !== undefined) {
    for (const level of ['info', 'warn', 'error'] as const) {
      if (typeof logger[level] !== 'function') {
        throw new UhttpError('INVALID_APP_OPTIONS', `Pass a logger with an ${level} method.`)
      }
    }
  }
  if (notFound !== undefined && typeof notFound !== 'function') {
    throw new UhttpError('INVALID_APP_OPTIONS', 'Pass a handler function as the notFound option.')
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new UhttpError('INVALID_APP_OPTIONS', 'Pass an error handler function as the onError option.')
  }
  return { logger, notFound, onError }
}

/**
 * You get an `App` from {@link createApp}, and you add middleware, groups, and routes to it. You
 * can then pass the app to {@link serve} to put it on the network, or call {@link App.request} to
 * test it without a network.
 */
export class App extends Group {
  readonly #runtime: AppRuntime
  #compiled: CompiledApp | undefined
  #compiledVersion = -1

  static {
    construct = runtime => new App(runtime)
    compile = app => app.#compile()
  }

  private constructor(runtime: AppRuntime) {
    super()
    this.#runtime = runtime
    attachGroup(this, new Registry(), '/', undefined)
  }

  /**
   * Returns the response that a client on the network receives for the same request, without
   * opening a port. The request passes through the same matcher, middleware chain, and request
   * context. The method lowercases header names, and it sends `host: localhost` when your headers
   * include no `Host`, as `fetch` does. It returns the same 400 as uWebSockets.js for more than 98
   * header lines, for a request line and headers above 4,096 bytes, and for an empty, repeated, or
   * invalid `Host`.
   *
   * @param target - You pass the path with an optional query string, such as `/search?q=uhttp`.
   * @param init - You can set the method, the headers, the client address, and an abort signal here.
   * @returns The promise resolves to a response with the status, the headers, and the body.
   */
  async request(target: string, init: TestRequestInit = {}): Promise<Response> {
    const { requestApp } = await import('./testing/index.js')
    return requestApp(this.#compile(), target, init)
  }

  #compile(): CompiledApp {
    const registry = registryOf(this)
    if (this.#compiled !== undefined && this.#compiledVersion === registry.version) return this.#compiled
    this.#compiled = compileApp(this.#runtime, registry)
    this.#compiledVersion = registry.version
    return this.#compiled
  }
}

/**
 * Returns the startup form of an app. The package builds that form again after you add a route, a
 * group, or a middleware.
 *
 * @param app - The package passes the app to compile.
 * @returns The function returns every route with its middleware chain, together with the
 * JavaScript matcher.
 * @internal
 */
export function compiledOf(app: App): CompiledApp {
  return compile(app)
}

/**
 * Returns a new app with no routes, so that you can add routes before you pass the app to
 * {@link serve}.
 *
 * @param options - You can pass a logger, a not-found handler, and an error handler here.
 * @returns The function returns the new app.
 * @throws {@link UhttpError} with the code `INVALID_APP_OPTIONS` when an option has the wrong type.
 */
export function createApp(options: AppOptions = {}): App {
  return construct(checkedRuntime(options))
}
