import { type CompiledApp, compileApp } from './compile.js'
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS } from './constants.js'
import { UhttpError } from './errors.js'
import type { AppRuntime } from './exchange.js'
import { attachGroup, Group, Registry, registryOf } from './group.js'
import { checkedLimit, checkedTimeLimit } from './limits.js'
import type { TestRequestInit } from './testing/index.js'
import type { AppOptions } from './types.js'
import type { PublishOptions, PubSubAdapter } from './websocket/types.js'

let construct: (runtime: AppRuntime) => App
let compile: (app: App) => CompiledApp
let connectPublisher: (app: App, publish: Publish | undefined) => void

type Publish = (topic: string, message: string | Uint8Array | ArrayBuffer, options?: PublishOptions) => void

const ADAPTER_METHODS = ['start', 'subscribe', 'unsubscribe', 'publish', 'close'] as const

function checkedAdapter(pubsub: PubSubAdapter | undefined): PubSubAdapter | undefined {
  if (pubsub === undefined) return undefined
  const value: unknown = pubsub
  const complete =
    typeof value === 'object' &&
    value !== null &&
    ADAPTER_METHODS.every(method => typeof Reflect.get(value, method) === 'function')
  if (!complete) {
    throw new UhttpError(
      'INVALID_APP_OPTIONS',
      `Pass a pub/sub adapter with the methods ${ADAPTER_METHODS.join(', ')} as the pubsub option.`,
    )
  }
  return pubsub
}

function checkedRuntime(options: AppOptions): AppRuntime {
  const { logger, notFound, onError, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = options
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
  return {
    logger,
    notFound,
    onError,
    maxBodyBytes: checkedLimit(maxBodyBytes, 'INVALID_APP_OPTIONS', 'maxBodyBytes'),
    timeoutMs: checkedTimeLimit(timeoutMs, 'INVALID_APP_OPTIONS'),
    pubsub: checkedAdapter(options.pubsub),
  }
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
  #publish: Publish | undefined

  static {
    construct = runtime => new App(runtime)
    compile = app => app.#compile()
    connectPublisher = (app, publish) => {
      app.#publish = publish
    }
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
   * invalid `Host`. When the package accepts a WebSocket upgrade, the method returns the 101 with
   * `sec-websocket-accept` and the first subprotocol that the request offers, but it opens no socket.
   *
   * @param target - You pass the path with an optional query string, such as `/search?q=uhttp`.
   * @param init - You can set the method, the headers, the client address, and an abort signal here.
   * @returns The promise resolves to a response with the status, the headers, and the body.
   */
  async request(target: string, init: TestRequestInit = {}): Promise<Response> {
    const { requestApp } = await import('./testing/index.js')
    return requestApp(this.#compile(), target, init)
  }

  /**
   * Sends a message to every WebSocket that has subscribed to a topic on any worker thread. When the
   * app has a pub/sub adapter, the package also passes the message to the adapter for the
   * subscribers on other servers. Because no socket can subscribe before {@link serve} has started
   * the app, the method drops any message that your code publishes before then.
   *
   * @param topic - You pass the name of the topic.
   * @param message - The package sends a string as text and bytes as a binary message, unless you
   * set `binary` in the options.
   * @param options - You can choose a binary or a text message and ask for compression here.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` when the server has started and the
   * topic is not a string or the message is neither a string nor bytes.
   */
  publish(topic: string, message: string | Uint8Array | ArrayBuffer, options?: PublishOptions): void {
    this.#publish?.(topic, message, options)
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
 * Connects {@link App.publish} to the hub of the thread that serves the app, or disconnects it once
 * the server closes.
 *
 * @param app - The package passes the app that it serves.
 * @param publish - The package passes the function that publishes through the hub, or `undefined`.
 * @internal
 */
export function setPublisher(app: App, publish: Publish | undefined): void {
  connectPublisher(app, publish)
}

/**
 * Returns a new app with no routes, so that you can add routes before you pass the app to
 * {@link serve}.
 *
 * @param options - You can pass a logger, a not-found handler, an error handler, a body limit, a
 * time limit, and a pub/sub adapter here.
 * @returns The function returns the new app.
 * @throws {@link UhttpError} with the code `INVALID_APP_OPTIONS` when an option has the wrong type,
 * when a limit is not a whole number of zero or more, or when the adapter is missing one of its
 * five methods.
 */
export function createApp(options: AppOptions = {}): App {
  return construct(checkedRuntime(options))
}
