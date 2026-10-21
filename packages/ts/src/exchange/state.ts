import { BodyArrival } from '../arrival.js'
import { UhttpError } from '../errors.js'
import { type Drain, SERVING } from '../native/drain.js'
import type { Reply } from '../reply.js'
import {
  type ContextHeaders,
  type DefaultHeaders,
  type EncodedHeader,
  type ResponseParts,
  storeHeader,
} from '../response.js'
import type { AppRuntime, BodyState } from '../runtime.js'
import { ExchangeEvents } from './events.js'

const SERVING_MODE = SERVING
const CLOSED = 1
const ABORTED = 2
const TIMED_OUT = 4
const CLOSE_AFTER_REPLY = 8
const CLIENT_CLOSES = 16
const DISCONNECTED = 32
const WATCHING_ABORT = 64
const LINGERING = 128
const FINAL = 256
const COUNTED = 512

/**
 * The package keeps the state of one request and its response in this object, from the abort
 * handler to the last write.
 *
 * @internal
 */
export class Exchange implements ResponseParts {
  /** The package reads the logger and the handlers of the app from these settings. */
  declare readonly runtime: AppRuntime
  /** This is the body reader of the request, or `undefined` on a route without one. */
  declare body: BodyState | undefined
  declare private readonly drain: Drain | undefined
  declare private flagBits: number
  declare private current: Reply | undefined
  declare private currentSetAt: number
  declare private clock: number
  declare private headerStore: ContextHeaders | undefined
  declare private defaultBlocks: DefaultHeaders[] | undefined
  declare private arrivalState: BodyArrival | undefined
  declare private events: ExchangeEvents | undefined

  /**
   * Creates the state of one request.
   *
   * @param runtime - The package passes the settings of the app that serves the request.
   * @param drain - The package passes the drain of the app of uWebSockets.js that serves the
   * request, or `undefined` for a request through `app.request()`.
   */
  constructor(runtime: AppRuntime, drain?: Drain) {
    this.runtime = runtime
    this.body = undefined
    this.drain = drain
    this.flagBits = 0
    this.current = undefined
    this.currentSetAt = 0
    this.clock = 0
    this.headerStore = undefined
    this.defaultBlocks = undefined
    this.arrivalState = undefined
    this.events = undefined
  }

  /**
   * This is `true` once the client has gone or the response has ended. From then on, the package
   * makes no call into uWebSockets.js.
   */
  get closed(): boolean {
    return (this.flagBits & CLOSED) !== 0
  }

  /** This is `true` when the client went before the response ended. */
  get aborted(): boolean {
    return (this.flagBits & ABORTED) !== 0
  }

  /** This is `true` once the handler has passed its time limit, from which point the package discards the reply of the chain. */
  get timedOut(): boolean {
    return (this.flagBits & TIMED_OUT) !== 0
  }

  /**
   * When this is `true`, the package closes the connection after the response, which it does after
   * an early rejection, after a `PAYLOAD_TOO_LARGE` error, after a time limit, and for a request
   * whose `transfer-encoding` it rejects.
   */
  get closeAfterReply(): boolean {
    return (this.flagBits & CLOSE_AFTER_REPLY) !== 0
  }

  set closeAfterReply(value: boolean) {
    this.mark(CLOSE_AFTER_REPLY, value)
  }

  /**
   * This is `true` when the client sent `connection: close`, after which uWebSockets.js closes the
   * connection as soon as the response ends.
   */
  get clientCloses(): boolean {
    return (this.flagBits & CLIENT_CLOSES) !== 0
  }

  set clientCloses(value: boolean) {
    this.mark(CLIENT_CLOSES, value)
  }

  /** This is `true` once the connection of the request has closed, even after the response ended. */
  get disconnected(): boolean {
    return (this.flagBits & DISCONNECTED) !== 0
  }

  /** This is `true` once the package has attached its abort handler to the response of uWebSockets.js. */
  get watchingAbort(): boolean {
    return (this.flagBits & WATCHING_ABORT) !== 0
  }

  set watchingAbort(value: boolean) {
    this.mark(WATCHING_ABORT, value)
  }

  /** This is `true` once the package sends a whole reply on a connection that the package closes itself later. */
  get lingering(): boolean {
    return (this.flagBits & LINGERING) !== 0
  }

  set lingering(value: boolean) {
    this.mark(LINGERING, value)
  }

  private mark(flag: number, value: boolean): void {
    this.flagBits = value ? this.flagBits | flag : this.flagBits & ~flag
  }

  private ensureEvents(): ExchangeEvents {
    this.events ??= new ExchangeEvents()
    return this.events
  }

  /** This is `true` when the client connected over TLS to the app of uWebSockets.js that serves the request. */
  get secure(): boolean {
    return this.drain?.secure === true
  }

  /**
   * Counts the request in the drain of its app when its response stays open after the handler of
   * uWebSockets.js returns. The method skips the request when the connection is closed. It also
   * skips a request whose response is over, unless the package closes that connection itself later.
   */
  countOpenResponse(): void {
    const drain = this.drain
    if (drain === undefined || (this.flagBits & COUNTED) !== 0 || this.disconnected || (this.closed && !this.lingering))
      return
    this.mark(COUNTED, true)
    drain.started()
  }

  private uncount(): void {
    if ((this.flagBits & COUNTED) === 0) return
    this.mark(COUNTED, false)
    this.drain?.finished()
  }

  /**
   * Returns the abort signal of the request. The package creates the signal on the first call, and
   * the signal fires when the client disconnects before the response ends or when the handler
   * passes its time limit.
   *
   * @returns The getter returns the same signal on every call.
   */
  get signal(): AbortSignal {
    return this.ensureEvents().signal
  }

  /**
   * The package follows the arrival of the request body through this object, which it creates on
   * the first access.
   */
  get arrival(): BodyArrival {
    this.arrivalState ??= new BodyArrival()
    return this.arrivalState
  }

  /** The package follows the arrival of the request body through this object, and it is `undefined` until the package creates it. */
  get startedArrival(): BodyArrival | undefined {
    return this.arrivalState
  }

  /** This is `true` while the app of uWebSockets.js that serves the request neither closes nor reloads, and for a request through `app.request()`. */
  get serving(): boolean {
    return this.drain === undefined || this.drain.mode === SERVING_MODE
  }

  /**
   * Records that the connection closed. Before the end of the response, the method also fires the
   * abort signal, releases the body reader and the upload destinations, and calls every close
   * listener.
   */
  abort(): void {
    this.mark(DISCONNECTED, true)
    this.uncount()
    this.events?.fireDisconnect()
    if (this.closed) return
    this.mark(ABORTED | CLOSED, true)
    const events = this.ensureEvents()
    const error = new UhttpError('REQUEST_ABORTED', 'The client disconnected before the request body ended.')
    events.fireSignal(undefined)
    this.body?.fail(error)
    events.release(error)
    this.body?.close()
    events.fireClose()
  }

  /**
   * Adds a listener that the package calls once the connection of the request closes, even when
   * that happens after the response ended.
   *
   * @param listener - The package calls this function once.
   */
  onDisconnect(listener: () => void): void {
    if (this.disconnected) listener()
    else this.ensureEvents().onDisconnect(listener)
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
    this.mark(TIMED_OUT | CLOSE_AFTER_REPLY, true)
    const events = this.ensureEvents()
    events.fireSignal(error)
    this.body?.fail(error)
    events.release(error)
  }

  /**
   * Returns `true` when only the reply and the default headers of middleware shape the response:
   * the route has no body reader, no body is on its way, your code set no header, and the
   * connection stays open after the response. The caller checks the default headers itself.
   *
   * @returns The method returns `false` when the package writes the reply through its full path.
   */
  writesReplyAlone(): boolean {
    return (
      (this.flagBits & (CLIENT_CLOSES | CLOSE_AFTER_REPLY)) === 0 &&
      this.body === undefined &&
      this.arrivalState === undefined &&
      this.headerStore === undefined &&
      (this.drain === undefined || this.drain.mode === SERVING_MODE)
    )
  }

  /**
   * Adds a listener that the package calls once with the error that ends the reading of the body,
   * which happens when the client disconnects or when the handler passes its time limit.
   *
   * @param listener - The package calls this function once.
   */
  onRelease(listener: (error: UhttpError) => void): void {
    this.ensureEvents().onRelease(listener)
  }

  /**
   * Calls every release listener once with the error that ends the reading of the body.
   *
   * @param error - The package passes the error that the body reader and the uploads fail with.
   */
  release(error: UhttpError): void {
    this.body?.fail(error)
    this.ensureEvents().release(error)
  }

  /**
   * Makes the body reader discard the part of the body that your code left unread, so that the
   * rest of the body keeps arriving after the response starts.
   */
  settleBody(): void {
    this.body?.settle()
  }

  /**
   * Records that the response is complete, and then calls every close listener.
   */
  end(): void {
    const flags = this.flagBits
    if ((flags & CLOSED) !== 0) return
    this.flagBits = flags | CLOSED
    if ((flags & (LINGERING | COUNTED)) === COUNTED) this.uncount()
    if (this.body !== undefined) this.body.close()
    if (this.events !== undefined) this.events.fireClose()
  }

  /**
   * Adds a listener that the package calls once, when the client goes or the response ends.
   *
   * @param listener - The package calls this function once.
   */
  onClose(listener: () => void): void {
    if (this.closed) listener()
    else this.ensureEvents().onClose(listener)
  }

  /** The chain has produced this reply so far, and it is `undefined` before any reply exists. */
  get reply(): Reply | undefined {
    return this.current
  }

  /** This number is the place of the current reply in the count of replies and headers of the request. */
  get replySetAt(): number {
    return this.currentSetAt
  }

  /** The package keeps the headers that code set through the context here, and this is `undefined` until code sets one. */
  get contextHeaders(): ContextHeaders | undefined {
    return this.headerStore
  }

  /** Middleware attached these blocks of headers in this order, and this is `undefined` until a middleware attaches one. */
  get defaultHeaders(): readonly DefaultHeaders[] | undefined {
    return this.defaultBlocks
  }

  /**
   * Attaches a block of headers that the package sends with whatever reply the request ends with,
   * apart from each header that the reply or your code sets.
   *
   * @param block - The middleware passes the block of headers.
   */
  addDefaultHeaders(block: DefaultHeaders): void {
    if (this.defaultBlocks === undefined) this.defaultBlocks = [block]
    else this.defaultBlocks.push(block)
  }

  /**
   * Makes a reply the current reply of the request. The package no longer sends the headers of the
   * reply that this one replaces, while it still sends the headers that your code set through the
   * context.
   *
   * @param reply - The package makes this reply the current one.
   */
  assign(reply: Reply): void {
    if ((this.flagBits & FINAL) !== 0 || reply === this.current) return
    this.current = reply
    this.currentSetAt = ++this.clock
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
    this.mark(FINAL, true)
  }

  /**
   * Puts a changed form of the current reply in its place, such as a compressed form, while the
   * package keeps the order of the headers that your code set through the context against the
   * reply.
   *
   * @param reply - The package passes the changed form of the current reply.
   */
  substitute(reply: Reply): void {
    if ((this.flagBits & FINAL) !== 0 || this.current === undefined) return
    this.current = reply
  }

  /**
   * Stores a response header that the caller has checked, which the package sends with whatever
   * reply the request ends with, unless the chain produced that reply later with a header of the
   * same name.
   *
   * @param lowerName - The caller passes the header name in lowercase.
   * @param value - The package sends this value.
   * @param encoded - The caller passes the header as bytes that a middleware built at startup, or `undefined`.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  storeHeader(lowerName: string, value: string, encoded: EncodedHeader | undefined, append: boolean): void {
    this.headerStore = storeHeader(this.headerStore, lowerName, value, encoded, append, ++this.clock)
  }
}
