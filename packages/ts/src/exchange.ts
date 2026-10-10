import { UhttpError } from './errors.js'
import { settableHeaderName } from './headers.js'
import type { Reply } from './reply.js'
import type { ErrorHandler, Handler, Logger } from './types.js'

const CONTENT_TYPE = 'content-type'

interface ContextHeader {
  readonly lines: string[]
  readonly appends: boolean
  setAt: number
}

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
  /** The package accepts a request body of up to this many bytes, unless the route sets its own limit. */
  readonly maxBodyBytes: number
  /** A handler has this many milliseconds before the package sends a 503, and 0 means no limit. */
  readonly timeoutMs: number
}

/**
 * Through this interface, the package checks with the body reader of a request whether it can keep
 * the connection open after the response.
 *
 * @internal
 */
export interface BodyState {
  /**
   * Returns `true` when the package must close the connection after the response, because the
   * reader stopped reading the body before its end. Otherwise, the reader discards the rest of the
   * body as uWebSockets.js delivers it.
   */
  settle(): boolean
  /**
   * Stops pausing the source for the rest of the request. uWebSockets.js stops writing to a paused
   * socket as well as reading from it, so the package calls this method when a streamed reply
   * starts. The reader can then hold up to the body limit of the route in chunks that your code
   * hasn't read.
   */
  keepFlowing(): void
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
  /** This is `true` once the handler has passed its time limit, from which point the package discards the reply of the chain. */
  timedOut = false
  /** When this is `true`, the package closes the connection after the response. */
  closeConnection = false
  /** This is the body reader of the request, or `undefined` on a route without one. */
  body: BodyState | undefined
  #reply: Reply | undefined
  #final = false
  #replySetAt = 0
  #headers: Map<string, ContextHeader> | undefined
  #clock = 0
  #controller: AbortController | undefined
  #signalFired = false
  #signalReason: unknown
  #listeners: (() => void)[] | undefined
  #released: UhttpError | undefined
  #releaseListeners: ((error: UhttpError) => void)[] | undefined

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
   * the signal fires when the client disconnects before the response ends or when the handler
   * passes its time limit.
   *
   * @returns The getter returns the same signal on every call.
   */
  get signal(): AbortSignal {
    if (this.#controller === undefined) {
      this.#controller = new AbortController()
      if (this.#signalFired) this.#controller.abort(this.#signalReason)
    }
    return this.#controller.signal
  }

  /**
   * Records that the client disconnected before the response ended. The method then fires the abort signal,
   * releases the body reader and the upload destinations, and calls every close listener.
   */
  abort(): void {
    if (this.closed) return
    this.aborted = true
    this.closed = true
    this.#fireSignal(undefined)
    this.release(new UhttpError('REQUEST_ABORTED', 'The client disconnected before the request body ended.'))
    this.#notify()
  }

  /**
   * Records that the handler passed its time limit. The method fires the abort signal with the
   * error as its reason and then releases the body reader and the upload destinations, but it
   * leaves the connection open for the 503.
   *
   * @param error - The package passes the `HANDLER_TIMEOUT` error.
   */
  expire(error: UhttpError): void {
    if (this.closed || this.timedOut) return
    this.timedOut = true
    this.closeConnection = true
    this.#fireSignal(error)
    this.release(error)
  }

  /**
   * Adds a listener that the package calls once with the error that ends the reading of the body,
   * which happens when the client disconnects or when the handler passes its time limit.
   *
   * @param listener - The package calls this function once.
   */
  onRelease(listener: (error: UhttpError) => void): void {
    if (this.#released !== undefined) {
      listener(this.#released)
      return
    }
    this.#releaseListeners ??= []
    this.#releaseListeners.push(listener)
  }

  /**
   * Calls every release listener once with the error that ends the reading of the body.
   *
   * @param error - The package passes the error that the body reader and the uploads fail with.
   */
  release(error: UhttpError): void {
    if (this.#released !== undefined) return
    this.#released = error
    const listeners = this.#releaseListeners
    this.#releaseListeners = undefined
    for (const listener of listeners ?? []) listener(error)
  }

  /**
   * Returns `true` when the package must close the connection after the response, because the
   * package rejected the request early or stopped reading its body, or because the handler passed
   * its time limit.
   *
   * @returns The method returns `false` when the connection can serve another request.
   */
  shouldCloseConnection(): boolean {
    if (this.body?.settle() === true) this.closeConnection = true
    return this.closeConnection
  }

  #fireSignal(reason: unknown): void {
    this.#signalFired = true
    this.#signalReason = reason
    this.#controller?.abort(reason)
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

  /** The chain has produced this reply so far, and it is `undefined` before any reply exists. */
  get reply(): Reply | undefined {
    return this.#reply
  }

  /**
   * Makes a reply the current reply of the request. The headers of a reply that this one replaces
   * no longer go out, while the headers that your code set through the context stay.
   *
   * @param reply - The package makes this reply the current one.
   */
  assign(reply: Reply): void {
    if (this.#final || reply === this.#reply) return
    this.#reply = reply
    this.#replySetAt = ++this.#clock
  }

  /**
   * Makes a reply the current reply of the request for good, so that a later reply of the chain
   * never replaces it. The package calls this method with the reply to a handler that passed its
   * time limit.
   *
   * @param reply - The package makes this reply the last one.
   */
  finalize(reply: Reply): void {
    this.assign(reply)
    this.#final = true
  }

  /**
   * Sets a response header after checking its name and its value. The header goes out with
   * whatever reply the request ends with, unless that reply arrived later with a header of the
   * same name.
   *
   * @param name - The package stores this header name in lowercase.
   * @param value - The package sends this value.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  setHeader(name: string, value: string, append: boolean): void {
    const lowerName = settableHeaderName(name, value)
    if (lowerName === undefined) return
    this.#headers ??= new Map()
    const setAt = ++this.#clock
    const existing = this.#headers.get(lowerName)
    if (append && existing !== undefined) {
      existing.lines.push(value)
      existing.setAt = setAt
      return
    }
    this.#headers.set(lowerName, { lines: [value], appends: append, setAt })
  }

  /**
   * Returns the content type that the package sends with the current reply. A `content-type`
   * header that your code set after the reply arrived replaces the content type of the reply.
   *
   * @returns The method returns the content type, or `undefined` when neither the reply nor your
   * code set one.
   */
  responseContentType(): string | undefined {
    const set = this.#headers?.get(CONTENT_TYPE)
    const replyType = this.#reply?.contentType
    if (set !== undefined && (replyType === undefined || set.setAt > this.#replySetAt)) return set.lines.at(-1)
    return replyType
  }

  /**
   * Calls a function for each line of every response header that goes out with the current reply,
   * apart from `content-type`. For a header that both the reply and your code set, the one that
   * your code or the reply set later goes out, and an appended line follows the lines of the reply.
   *
   * @param emit - The package calls this function with the lowercase name and the value of each line.
   */
  forEachResponseHeader(emit: (name: string, value: string) => void): void {
    const replyHeaders = this.#reply?.headers
    const setHeaders = this.#headers
    if (replyHeaders !== undefined) {
      for (const [name, lines] of replyHeaders) {
        const set = setHeaders?.get(name)
        if (set !== undefined && set.setAt > this.#replySetAt && !set.appends) continue
        for (const line of lines) emit(name, line)
      }
    }
    if (setHeaders === undefined) return
    for (const [name, set] of setHeaders) {
      if (name === CONTENT_TYPE) continue
      if (replyHeaders?.has(name) === true && set.setAt < this.#replySetAt) continue
      for (const line of set.lines) emit(name, line)
    }
  }

  #notify(): void {
    const listeners = this.#listeners
    if (listeners === undefined) return
    this.#listeners = undefined
    for (const listener of listeners) listener()
  }
}
