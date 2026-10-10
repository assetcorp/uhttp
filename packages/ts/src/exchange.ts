import { type HeaderLines, putHeader } from './headers.js'
import type { Reply } from './reply.js'
import type { ErrorHandler, Handler, Logger } from './types.js'

/**
 * The package shares these settings of one app with every request to that app.
 *
 * @internal
 */
export interface AppRuntime {
  /** The package writes every 500 to this logger. */
  readonly logger: Logger | undefined
  /** The package calls this handler for a path that has no route. */
  readonly notFound: Handler | undefined
  /** The package calls this handler for every error that the chain throws. */
  readonly onError: ErrorHandler | undefined
}

/**
 * The package keeps the state of one request and its response in this object, from the abort
 * handler to the last write.
 *
 * @internal
 */
export class Exchange {
  /** The package reads the logger and the handlers of the app from these settings. */
  readonly runtime: AppRuntime
  /**
   * This is `true` once the client has gone or the response has ended. From then on, the package
   * makes no call into uWebSockets.js.
   */
  closed = false
  /** This is `true` when the client went before the response ended. */
  aborted = false
  /** The chain has produced this reply so far, and it is `undefined` before any reply exists. */
  reply: Reply | undefined
  /** Your code set these response headers through the context, and the package keys them by lowercase name. */
  headers: HeaderLines | undefined
  #controller: AbortController | undefined
  #listeners: (() => void)[] | undefined

  /**
   * Creates the state of one request.
   *
   * @param runtime - The package passes the settings of the app that serves the request.
   */
  constructor(runtime: AppRuntime) {
    this.runtime = runtime
  }

  /**
   * Returns the abort signal of the request. The package creates the signal on the first call, and
   * the signal fires when the client goes before the response ends.
   *
   * @returns The getter returns the same signal on every call.
   */
  get signal(): AbortSignal {
    if (this.#controller === undefined) {
      this.#controller = new AbortController()
      if (this.aborted) this.#controller.abort()
    }
    return this.#controller.signal
  }

  /**
   * Records that the client went before the response ended. The method then fires the abort signal
   * and calls every close listener.
   */
  abort(): void {
    if (this.closed) return
    this.aborted = true
    this.closed = true
    this.#controller?.abort()
    this.#notify()
  }

  /**
   * Records that the response is complete, and then calls every close listener.
   */
  end(): void {
    if (this.closed) return
    this.closed = true
    this.#notify()
  }

  /**
   * Adds a listener that the package calls once, when the client goes or the response ends.
   *
   * @param listener - The package calls this function once.
   */
  onClose(listener: () => void): void {
    if (this.closed) {
      listener()
      return
    }
    this.#listeners ??= []
    this.#listeners.push(listener)
  }

  /**
   * Makes a reply the current reply of the request. The headers of the reply replace any header of
   * the same name that your code set earlier, and the package keeps every other header.
   *
   * @param reply - The package makes this reply the current one.
   */
  assign(reply: Reply): void {
    if (reply === this.reply) return
    if (reply.contentType !== undefined) this.headers?.delete('content-type')
    if (reply.headers !== undefined) {
      this.headers ??= new Map()
      for (const [name, lines] of reply.headers) this.headers.set(name, [...lines])
    }
    this.reply = reply
  }

  /**
   * Returns the content type that the package sends with a reply. A `content-type` header that your
   * code set after the reply arrived replaces the content type of the reply.
   *
   * @param reply - The package passes the reply that it writes.
   * @returns The method returns the content type, or `undefined` when the reply has none.
   */
  contentTypeOf(reply: Reply): string | undefined {
    return this.headers?.get('content-type')?.at(-1) ?? reply.contentType
  }

  /**
   * Sets a response header after checking its name and its value.
   *
   * @param name - The package stores this header name in lowercase.
   * @param value - The package sends this value.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  setHeader(name: string, value: string, append: boolean): void {
    this.headers ??= new Map()
    putHeader(this.headers, name, value, append)
  }

  #notify(): void {
    const listeners = this.#listeners
    if (listeners === undefined) return
    this.#listeners = undefined
    for (const listener of listeners) listener()
  }
}
