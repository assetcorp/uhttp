import { BodyArrival } from './arrival.js'
import { UhttpError } from './errors.js'
import { settableHeaderName } from './headers.js'
import { addListener, type OnceListeners } from './listeners.js'
import type { Reply } from './reply.js'
import type { ErrorHandler, Handler, Logger } from './types.js'
import type { PubSubAdapter } from './websocket/types.js'

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
  /** The package passes each message that your code publishes to this adapter, which is `undefined` when you pass none. */
  readonly pubsub: PubSubAdapter | undefined
}

/**
 * Through this interface, the package controls the body reader of a request once the response
 * starts.
 *
 * @internal
 */
export interface BodyState {
  /**
   * Makes the reader discard the rest of the body as it arrives, and resumes a paused source, so
   * that the rest of the body keeps arriving after the response starts.
   */
  settle(): void
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
  /**
   * When this is `true`, the package closes the connection after the response, which it does after
   * an early rejection, after a `PAYLOAD_TOO_LARGE` error, after a time limit, and for a request
   * whose `transfer-encoding` it rejects.
   */
  closeAfterReply = false
  /**
   * This is `true` when the client sent `connection: close`, after which uWebSockets.js closes the
   * connection as soon as the response ends.
   */
  clientCloses = false
  /** This is the body reader of the request, or `undefined` on a route without one. */
  body: BodyState | undefined
  /** This is `true` once the connection of the request has closed, even after the response ended. */
  disconnected = false
  /** This is `true` once the package has attached its abort handler to the response of uWebSockets.js. */
  watchingAbort = false
  #arrival: BodyArrival | undefined
  #reply: Reply | undefined
  #final = false
  #replySetAt = 0
  #headers: Map<string, ContextHeader> | undefined
  #clock = 0
  #controller: AbortController | undefined
  #signalFired = false
  #signalReason: unknown
  #released: UhttpError | undefined
  #closing: OnceListeners<void> | undefined
  #disconnection: OnceListeners<void> | undefined
  #release: OnceListeners<UhttpError> | undefined

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
   * The package follows the arrival of the request body through this object, which it creates on
   * the first access.
   */
  get arrival(): BodyArrival {
    this.#arrival ??= new BodyArrival()
    return this.#arrival
  }

  /**
   * Records that the connection closed. Before the end of the response, the method also fires the
   * abort signal, releases the body reader and the upload destinations, and calls every close
   * listener.
   */
  abort(): void {
    this.disconnected = true
    this.#disconnection?.fire(undefined)
    if (this.closed) return
    this.aborted = true
    this.closed = true
    this.#fireSignal(undefined)
    this.release(new UhttpError('REQUEST_ABORTED', 'The client disconnected before the request body ended.'))
    this.#closing?.fire(undefined)
  }

  /**
   * Adds a listener that the package calls once the connection of the request closes, even when
   * that happens after the response ended.
   *
   * @param listener - The package calls this function once.
   */
  onDisconnect(listener: () => void): void {
    if (this.disconnected) listener()
    else this.#disconnection = addListener(this.#disconnection, listener)
  }

  /**
   * Records that the handler passed its time limit. The method fires the abort signal with the
   * error as its reason and then releases the body reader and the upload destinations. The package
   * then sends the 503 and closes the connection after it.
   *
   * @param error - The package passes the `HANDLER_TIMEOUT` error.
   */
  expire(error: UhttpError): void {
    if (this.closed || this.timedOut) return
    this.timedOut = true
    this.closeAfterReply = true
    this.#fireSignal(error)
    this.release(error)
  }

  /**
   * Returns `true` when the package closes the connection after the response for a reason of its
   * own, which the reply then announces with `Connection: close`. The reason is an early rejection,
   * a `PAYLOAD_TOO_LARGE` error, a time limit, a rejected `transfer-encoding`, or more of the body on
   * its way than the package discards to keep the connection open.
   *
   * @returns The method returns `false` when only the client can ask for the close.
   */
  serverCloses(): boolean {
    return this.closeAfterReply || this.#arrival?.unbounded === true
  }

  /**
   * Returns `true` when the connection closes after the response, because the client or the
   * package asked for the close.
   *
   * @returns The method returns `false` when the connection can serve another request.
   */
  closesConnection(): boolean {
    return this.clientCloses || this.serverCloses()
  }

  /**
   * Returns `true` when the package closes the connection after the response while more of the
   * body is on its way, which means that the package has to keep reading the body after the reply.
   *
   * @returns The method returns `false` when the response can end in the usual way.
   */
  closesBeforeBodyEnds(): boolean {
    return this.#arrival?.arriving === true && this.closesConnection()
  }

  /**
   * Returns `true` when the package sends the reply with `Connection: close` and closes the
   * connection itself later. It does so when it closes while more of the body is on its way, and
   * when it closes after a reply without a length, which uWebSockets.js can't end with a close.
   *
   * @param lengthless - The caller passes `true` for a reply that carries neither a body nor a length.
   * @returns The method returns `false` when the reply can end with or without a close in the usual way.
   */
  lingersAfterReply(lengthless: boolean): boolean {
    return this.closesBeforeBodyEnds() || (lengthless && this.serverCloses())
  }

  /**
   * Adds a listener that the package calls once with the error that ends the reading of the body,
   * which happens when the client disconnects or when the handler passes its time limit.
   *
   * @param listener - The package calls this function once.
   */
  onRelease(listener: (error: UhttpError) => void): void {
    if (this.#released !== undefined) listener(this.#released)
    else this.#release = addListener(this.#release, listener)
  }

  /**
   * Calls every release listener once with the error that ends the reading of the body.
   *
   * @param error - The package passes the error that the body reader and the uploads fail with.
   */
  release(error: UhttpError): void {
    if (this.#released !== undefined) return
    this.#released = error
    this.#release?.fire(error)
  }

  /**
   * Makes the body reader discard the part of the body that your code left unread, so that the
   * rest of the body keeps arriving after the response starts.
   */
  settleBody(): void {
    this.body?.settle()
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
    this.#closing?.fire(undefined)
  }

  /**
   * Adds a listener that the package calls once, when the client goes or the response ends.
   *
   * @param listener - The package calls this function once.
   */
  onClose(listener: () => void): void {
    if (this.closed) listener()
    else this.#closing = addListener(this.#closing, listener)
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
   * Returns `true` when the current reply carries headers or your code set a header, so that
   * {@link Exchange.forEachResponseHeader} can have lines to pass on.
   *
   * @returns The method returns `false` when that method has no line to pass on.
   */
  hasResponseHeaders(): boolean {
    return this.#reply?.headers !== undefined || this.#headers !== undefined
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
}
