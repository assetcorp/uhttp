import { BODY_HIGH_WATER_MARK_BYTES, BODY_PAUSE_TIMEOUT_MS } from '../constants.js'
import { UhttpError } from '../errors.js'
import type { Exchange } from '../exchange/index.js'
import { isDecimalDigits } from '../headers.js'
import type { BodyState } from '../runtime.js'

const IDENTITY = 'identity'

interface Waiter<T> {
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

/**
 * The body reader controls the flow of the body through this interface, which the package
 * implements once over uWebSockets.js and once for `app.request()`.
 *
 * @internal
 */
export interface BodySource {
  /** Stops the flow of the body until the next call to `resume`. */
  pause(): void
  /** Restarts the flow of the body. */
  resume(): void
  /** Closes the connection, after which the package treats the client as disconnected. */
  close(): void
}

/**
 * The package reads these framing headers of a request before it attaches a body reader.
 *
 * @internal
 */
export interface BodyFraming {
  /** This holds the raw `content-length` header, or `undefined` when the request has none. */
  readonly contentLength: string | undefined
  /** This holds the `transfer-encoding` header, or `undefined` when the request has none. */
  readonly transferEncoding: string | undefined
  /** This holds the `content-encoding` header, or `undefined` when the request has none. */
  readonly contentEncoding: string | undefined
}

/**
 * Returns the error with which the package rejects a request before it reads any of the body: a
 * 415 for a compressed body, or a 413 for a declared length above the limit.
 *
 * @param framing - The package passes the framing headers of the request.
 * @param limit - The package passes the body limit of the route in bytes.
 * @returns The function returns the error, or `undefined` when the package can read the body.
 * @internal
 */
export function earlyRejection(framing: BodyFraming, limit: number): UhttpError | undefined {
  const { contentEncoding } = framing
  if (contentEncoding !== undefined && contentEncoding.trim().toLowerCase() !== IDENTITY) {
    return new UhttpError(
      'UNSUPPORTED_MEDIA_TYPE',
      'Send the request body uncompressed, without a Content-Encoding header.',
    )
  }
  const declared = declaredLength(framing)
  return declared !== undefined && declared > limit ? tooLarge(limit) : undefined
}

/**
 * Returns the length of the body that a request declares in `content-length`.
 *
 * @param framing - The package passes the framing headers of the request.
 * @returns The function returns the length in bytes, or `undefined` when the header is missing or
 * is not a whole number.
 * @internal
 */
export function declaredLength(framing: Pick<BodyFraming, 'contentLength'>): number | undefined {
  const { contentLength } = framing
  return contentLength !== undefined && isDecimalDigits(contentLength) ? Number(contentLength) : undefined
}

/**
 * Returns `true` when a request has no body, because it declares a length of 0, or because it
 * declares neither a length nor a chunked encoding.
 *
 * @param framing - The package passes the framing headers of the request.
 * @returns The function returns `false` when a body can follow the headers.
 * @internal
 */
export function declaresNoBody(framing: Pick<BodyFraming, 'contentLength' | 'transferEncoding'>): boolean {
  if (framing.contentLength !== undefined) return declaredLength(framing) === 0
  return framing.transferEncoding === undefined
}

function tooLarge(limit: number): UhttpError {
  return new UhttpError('PAYLOAD_TOO_LARGE', `The request body is larger than the limit of ${limit} bytes.`)
}

/**
 * The package queues the chunks of one request body in this reader. The reader counts the bytes as
 * the source delivers them, and it pauses the source once it holds
 * {@link BODY_HIGH_WATER_MARK_BYTES} bytes that the handler hasn't read. When the source stays paused
 * for {@link BODY_PAUSE_TIMEOUT_MS} milliseconds, the reader closes the connection, because
 * uWebSockets.js clears its idle timer during a pause.
 *
 * @internal
 */
export class BodyReader implements BodyState {
  /** The reader fails once the body passes this many bytes. */
  readonly limit: number
  readonly #exchange: Exchange
  readonly #source: BodySource
  readonly #queue: Uint8Array[] = []
  #queuedBytes = 0
  #received = 0
  #ended = false
  #discarding = false
  #paused = false
  #flowing = false
  #error: UhttpError | undefined
  #waiter: Waiter<Uint8Array | undefined> | undefined
  #collector: Waiter<Uint8Array> | undefined
  #pauseTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Creates the reader of one request body and attaches it to the state of the request.
   *
   * @param exchange - The package passes the state of the request, which releases the reader.
   * @param source - The package passes the source that the reader pauses and resumes.
   * @param limit - The package passes the body limit of the route in bytes.
   * @param empty - The package passes `true` when the request has no body.
   */
  constructor(exchange: Exchange, source: BodySource, limit: number, empty: boolean) {
    this.limit = limit
    this.#exchange = exchange
    this.#source = source
    this.#ended = empty
    exchange.body = this
  }

  /** This is `true` while the reader queues the chunks that the source delivers. */
  get accepting(): boolean {
    return this.#error === undefined && !this.#ended && !this.#discarding
  }

  /**
   * Adds a copied chunk of the body. The reader fails with `PAYLOAD_TOO_LARGE` once the count passes
   * the limit, and from then on it discards the rest of the body as it arrives and makes the package
   * close the connection after the reply, whatever reply your code sends. It pauses the source
   * once it holds {@link BODY_HIGH_WATER_MARK_BYTES} bytes that the handler hasn't read.
   *
   * @param chunk - The source passes a copy of the bytes, which the reader keeps.
   * @param last - The source passes `true` with the last chunk of the body.
   */
  push(chunk: Uint8Array, last: boolean): void {
    if (this.accepting) this.#take(chunk, last)
    if (!last) return
    this.#ended = true
    this.#wake()
    this.#deliver()
    this.#exchange.arrival.ended()
  }

  /**
   * Fails every read from now on with an error, and drops the queued chunks.
   *
   * @param error - The package passes the error that every read rejects with.
   */
  fail(error: UhttpError): void {
    if (this.#error !== undefined) return
    this.#error = error
    this.#queue.length = 0
    this.#queuedBytes = 0
    const waiter = this.#waiter
    const collector = this.#collector
    this.#waiter = undefined
    this.#collector = undefined
    waiter?.reject(error)
    collector?.reject(error)
  }

  /**
   * Returns the next chunk of the body, and resumes the source once the queue drops below
   * {@link BODY_HIGH_WATER_MARK_BYTES} bytes.
   *
   * @returns The promise resolves to the next chunk, or to `undefined` at the end of the body. It
   * rejects with the error of a failed reader.
   */
  read(): Promise<Uint8Array | undefined> {
    if (this.#error !== undefined) return Promise.reject(this.#error)
    const chunk = this.#queue.shift()
    if (chunk !== undefined) {
      this.#queuedBytes -= chunk.byteLength
      if (this.#paused && this.#queuedBytes < BODY_HIGH_WATER_MARK_BYTES) this.#resume()
      return Promise.resolve(chunk)
    }
    if (this.#ended) return Promise.resolve(undefined)
    if (this.#paused) this.#resume()
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject }
    })
  }

  /**
   * Returns the whole body once its last chunk arrives. While the reader collects the body, it
   * never pauses the source, because it keeps every chunk until the end of the body anyway, and
   * the body limit of the route still applies. The caller reads the body either through this
   * method once or through {@link BodyReader.read}, never both.
   *
   * @returns The promise resolves to the bytes of the body. It rejects with the error of a failed
   * reader.
   */
  collect(): Promise<Uint8Array> {
    if (this.#error !== undefined) return Promise.reject(this.#error)
    this.keepFlowing()
    if (this.#ended) return Promise.resolve(this.#drained())
    return new Promise((resolve, reject) => {
      this.#collector = { resolve, reject }
    })
  }

  /**
   * Discards the chunks that the handler hasn't read and every chunk that arrives later, and
   * resumes a paused source, so that the rest of the body keeps arriving after the response starts.
   */
  settle(): void {
    if (this.#paused) this.#resume()
    this.#discarding = true
    if (this.#collector !== undefined) return
    this.#queue.length = 0
    this.#queuedBytes = 0
  }

  /**
   * Stops pausing the source for the rest of the request, and resumes it when it is paused, so that
   * uWebSockets.js can write a streamed reply while the handler leaves the body unread.
   */
  keepFlowing(): void {
    this.#flowing = true
    if (this.#paused) this.#resume()
  }

  #take(chunk: Uint8Array, last: boolean): void {
    this.#received += chunk.byteLength
    if (this.#received > this.limit) {
      this.fail(tooLarge(this.limit))
      this.#discarding = true
      this.#exchange.closeAfterReply = true
      return
    }
    if (chunk.byteLength > 0) {
      this.#queue.push(chunk)
      this.#queuedBytes += chunk.byteLength
    }
    if (last) return
    this.#wake()
    if (this.#queuedBytes >= BODY_HIGH_WATER_MARK_BYTES) this.#pause()
  }

  #wake(): void {
    const waiter = this.#waiter
    if (waiter === undefined) return
    const chunk = this.#queue.shift()
    if (chunk === undefined && !this.#ended) return
    this.#waiter = undefined
    if (chunk !== undefined) this.#queuedBytes -= chunk.byteLength
    waiter.resolve(chunk)
  }

  #deliver(): void {
    const collector = this.#collector
    if (collector === undefined) return
    this.#collector = undefined
    collector.resolve(this.#drained())
  }

  #drained(): Uint8Array {
    const queue = this.#queue
    const first = queue[0]
    const whole = queue.length === 1 && first !== undefined ? first : Buffer.concat(queue, this.#queuedBytes)
    queue.length = 0
    this.#queuedBytes = 0
    return whole
  }

  #pause(): void {
    if (this.#paused || this.#flowing) return
    this.#paused = true
    this.#source.pause()
    this.#pauseTimer = setTimeout(() => {
      this.#pauseTimer = undefined
      this.#source.close()
    }, BODY_PAUSE_TIMEOUT_MS)
  }

  #resume(): void {
    this.#paused = false
    this.#stopTimer()
    this.#source.resume()
  }

  /**
   * Stops the pause timer once the client goes or the response ends, and fails a reader whose body
   * has not ended with `REQUEST_ABORTED`.
   */
  close(): void {
    this.#stopTimer()
    if (!this.#ended) this.fail(new UhttpError('REQUEST_ABORTED', 'The response ended before the request body.'))
  }

  #stopTimer(): void {
    if (this.#pauseTimer === undefined) return
    clearTimeout(this.#pauseTimer)
    this.#pauseTimer = undefined
  }
}
