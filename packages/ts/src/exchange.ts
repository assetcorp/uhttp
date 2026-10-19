import { BodyArrival } from './arrival.js'
import { UhttpError } from './errors.js'
import { settableHeaderName } from './headers.js'
import { addListener, type OnceListeners } from './listeners.js'
import { type Drain, SERVING } from './native/drain.js'
import type { Reply } from './reply.js'
import {
  type ContextHeaders,
  type DefaultHeaders,
  type EncodedHeader,
  type PreparedHeader,
  type PreparedName,
  type ResponseParts,
  storeHeader,
} from './response.js'
import type { AppRuntime, BodyState } from './runtime.js'

/**
 * The package keeps the state of one request and its response in this object, from the abort
 * handler to the last write.
 *
 * @internal
 */
export class Exchange implements ResponseParts {
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
  /** This is `true` once the package sends a whole reply on a connection that the package closes itself later. */
  lingering = false
  readonly #drain: Drain | undefined
  #reply: Reply | undefined
  #final = false
  #replySetAt = 0
  #headers: ContextHeaders | undefined
  #defaults: DefaultHeaders[] | undefined
  #clock = 0
  #counted = false
  #arrival: BodyArrival | undefined
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
   * @param drain - The package passes the drain of the app of uWebSockets.js that serves the
   * request, or `undefined` for a request through `app.request()`.
   */
  constructor(runtime: AppRuntime, drain?: Drain) {
    this.runtime = runtime
    this.#drain = drain
  }

  /** This is `true` when the client connected over TLS to the app of uWebSockets.js that serves the request. */
  get secure(): boolean {
    return this.#drain?.secure === true
  }

  /**
   * Counts the request in the drain of its app when its response stays open after the handler of
   * uWebSockets.js returns. The method skips the request when the connection is closed. It also
   * skips a request whose response is over, unless the package closes that connection itself later.
   */
  countOpenResponse(): void {
    const drain = this.#drain
    if (drain === undefined || this.#counted || this.disconnected || (this.closed && !this.lingering)) return
    this.#counted = true
    drain.started()
  }

  #uncount(): void {
    if (!this.#counted) return
    this.#counted = false
    this.#drain?.finished()
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
    this.#uncount()
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
   * own, in which case the reply contains `Connection: close`. The reason is an early rejection, a
   * `PAYLOAD_TOO_LARGE` error, a time limit, a rejected `transfer-encoding`, an unread rest of the
   * body that is longer than the package discards to keep the connection open, or a server that is
   * closing or reloading.
   *
   * @returns The method returns `false` when only the client can ask for the close.
   */
  serverCloses(): boolean {
    return (
      this.closeAfterReply ||
      this.#arrival?.unbounded === true ||
      (this.#drain !== undefined && this.#drain.mode !== SERVING)
    )
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
    if (!this.lingering) this.#uncount()
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

  /** This number is the place of the current reply in the count of replies and headers of the request. */
  get replySetAt(): number {
    return this.#replySetAt
  }

  /** The package keeps the headers that code set through the context here, and this is `undefined` until code sets one. */
  get contextHeaders(): ContextHeaders | undefined {
    return this.#headers
  }

  /** Middleware attached these blocks of headers in this order, and this is `undefined` until a middleware attaches one. */
  get defaultHeaders(): readonly DefaultHeaders[] | undefined {
    return this.#defaults
  }

  /**
   * Attaches a block of headers that the package sends with whatever reply the request ends with,
   * apart from each header that the reply or your code sets.
   *
   * @param block - The middleware passes the block of headers.
   */
  addDefaultHeaders(block: DefaultHeaders): void {
    if (this.#defaults === undefined) this.#defaults = [block]
    else this.#defaults.push(block)
  }

  /**
   * Makes a reply the current reply of the request. The package no longer sends the headers of the
   * reply that this one replaces, while it still sends the headers that your code set through the
   * context.
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
   * Puts a changed form of the current reply in its place, such as a compressed form, while the
   * package keeps the order of the headers that your code set through the context against the
   * reply.
   *
   * @param reply - The package passes the changed form of the current reply.
   */
  substitute(reply: Reply): void {
    if (this.#final || this.#reply === undefined) return
    this.#reply = reply
  }

  /**
   * Sets a response header after checking its name and its value. The package sends the header
   * with whatever reply the request ends with, unless the chain produced that reply later with a
   * header of the same name.
   *
   * @param name - The package stores this header name in lowercase.
   * @param value - The package sends this value.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  setHeader(name: string, value: string, append: boolean): void {
    const lowerName = settableHeaderName(name, value)
    if (lowerName !== undefined) this.#store(lowerName, value, undefined, append)
  }

  /**
   * Sets a response header that a middleware checked and encoded once at startup. The method
   * checks it no further.
   *
   * @param header - The middleware passes the prepared header.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  setFixed(header: PreparedHeader, append: boolean): void {
    this.#store(header.name, header.value, header.encoded, append)
  }

  /**
   * Sets a response header under a name that a middleware prepared at startup, with a value that
   * the middleware built and checked for this request. The method checks neither of them again.
   *
   * @param name - The middleware passes the prepared name.
   * @param value - The middleware passes the checked value.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  setPrepared(name: PreparedName, value: string, append: boolean): void {
    this.#store(name.name, value, name.encoded, append)
  }

  #store(lowerName: string, value: string, encoded: EncodedHeader | undefined, append: boolean): void {
    this.#headers = storeHeader(this.#headers, lowerName, value, encoded, append, ++this.#clock)
  }
}
