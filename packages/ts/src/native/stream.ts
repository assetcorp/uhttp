import type { HttpResponse } from 'uWebSockets.js'
import { logServerError } from '../chain.js'
import type { Context } from '../context.js'
import { closesBeforeBodyEnds, type Exchange } from '../exchange/index.js'
import { type ResponseStream, type StreamProducer, streamShortfallError, streamWriteError } from '../reply.js'
import { closeConnection } from './close.js'
import { holdForBody } from './hold.js'

interface QueuedChunk {
  readonly bytes: Uint8Array
  readonly resolve: (written: boolean) => void
}

interface PartialChunk {
  readonly bytes: Uint8Array
  readonly baseOffset: number
}

function toBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? Buffer.from(chunk) : chunk
}

/**
 * The package writes a streamed body to uWebSockets.js through this object. It writes a body of
 * unknown length with `write()` and a body of known length with `tryEnd()`. Whenever the client
 * reads slowly, the package waits for `onWritable` before it writes more. When the connection
 * closes after the response while the request body is still arriving, the object holds the end of
 * the response until the last byte of the body arrives. When the body is still arriving once
 * {@link holdForBody} stops waiting, the object sends all but the last byte of the reply and waits
 * for the socket to drain. It then pauses the socket, so that the package reads no more of the
 * body, and sends the rest, which ends the response. uWebSockets.js then closes the idle
 * connection, or closes it at once when the client sent `Connection: close`.
 *
 * @internal
 */
export class NativeStream implements ResponseStream {
  readonly #res: HttpResponse
  readonly #exchange: Exchange
  readonly #context: Context
  readonly #length: number | undefined
  readonly #queue: QueuedChunk[] = []
  #accepted = 0
  #blocked = false
  #partial: PartialChunk | undefined
  #held: QueuedChunk | undefined
  #waiter: ((written: boolean) => void) | undefined
  #returned = false
  #finishing = false
  #stopRequested = false
  #readingStopped = false

  /**
   * Creates the stream of one response.
   *
   * @param res - The package passes the response of uWebSockets.js.
   * @param exchange - The package passes the state of the request.
   * @param context - The package passes the context of the request, and it logs a failure with the method and the path of that request.
   * @param length - You declared this length in bytes, and it is `undefined` for a chunked body.
   */
  constructor(res: HttpResponse, exchange: Exchange, context: Context, length: number | undefined) {
    this.#res = res
    this.#exchange = exchange
    this.#context = context
    this.#length = length
    exchange.onClose(() => this.#release())
  }

  get closed(): boolean {
    return this.#exchange.closed
  }

  onClose(listener: () => void): void {
    this.#exchange.onClose(listener)
  }

  write(chunk: string | Uint8Array): Promise<boolean> {
    if (this.#exchange.closed) return Promise.resolve(false)
    const bytes = toBytes(chunk)
    const error = streamWriteError(this.#returned, this.#accepted, bytes.byteLength, this.#length)
    if (error !== undefined) return Promise.reject(error)
    this.#accepted += bytes.byteLength
    if (this.#accepted === this.#length && this.#holdsEnd()) return this.#hold(bytes)
    if (this.#blocked) {
      return new Promise(resolve => {
        this.#queue.push({ bytes, resolve })
      })
    }
    if (this.#send(bytes)) return Promise.resolve(true)
    return new Promise(resolve => {
      this.#waiter = resolve
    })
  }

  /**
   * Starts the producer, and ends the response once the producer returns. When the producer
   * throws, the method closes the connection, so that the client can detect the truncated body.
   *
   * @param produce - The package passes the stream producer of the reply.
   */
  start(produce: StreamProducer): void {
    if (this.#length === undefined) this.#res.beginWrite()
    this.#res.onWritable(offset => this.#onWritable(offset))
    let result: void | Promise<void>
    try {
      result = produce(this)
    } catch (error) {
      this.#fail(error)
      return
    }
    Promise.resolve(result).then(
      () => this.#producerReturned(),
      error => this.#fail(error),
    )
  }

  #send(bytes: Uint8Array): boolean {
    const res = this.#res
    if (this.#length === undefined) {
      let written = false
      res.cork(() => {
        written = res.write(bytes)
      })
      if (!written) this.#blocked = true
      return written
    }
    const baseOffset = res.getWriteOffset()
    let result: [boolean, boolean] = [false, false]
    res.cork(() => {
      result = res.tryEnd(bytes, this.#length ?? 0)
    })
    const [ok, done] = result
    if (done) {
      this.#exchange.end()
      return true
    }
    if (ok) return true
    this.#blocked = true
    this.#partial = { bytes, baseOffset }
    return false
  }

  #onWritable(offset: number): boolean {
    if (this.#exchange.closed) return true
    const partial = this.#partial
    if (partial !== undefined) {
      const [ok, done] = this.#res.tryEnd(partial.bytes.subarray(offset - partial.baseOffset), this.#length ?? 0)
      if (done) {
        this.#partial = undefined
        this.#exchange.end()
        return true
      }
      if (!ok) return false
      this.#partial = undefined
    }
    this.#blocked = false
    this.#resolveWaiter(true)
    this.#drain()
    return true
  }

  #drain(): void {
    while (!this.#blocked && !this.#exchange.closed) {
      const next = this.#queue.shift()
      if (next === undefined) break
      if (this.#send(next.bytes)) {
        next.resolve(true)
        continue
      }
      this.#waiter = next.resolve
    }
    if (this.#blocked) return
    if (this.#stopRequested && !this.#readingStopped) this.#stopReadingOnceDrained()
    else if (this.#finishing) this.#complete()
  }

  #resolveWaiter(written: boolean): void {
    const waiter = this.#waiter
    this.#waiter = undefined
    waiter?.(written)
  }

  #release(): void {
    this.#resolveWaiter(false)
    for (const queued of this.#queue.splice(0)) queued.resolve(false)
    const held = this.#held
    this.#held = undefined
    held?.resolve(false)
  }

  #producerReturned(): void {
    this.#returned = true
    if (this.#exchange.closed) return
    this.#finishing = true
    if (!this.#blocked) this.#complete()
  }

  #complete(): void {
    this.#finishing = false
    if (this.#exchange.closed || this.#held !== undefined) return
    const shortfall = streamShortfallError(this.#accepted, this.#length)
    if (shortfall !== undefined) {
      this.#fail(shortfall)
      return
    }
    this.#exchange.settleBody()
    const res = this.#res
    if (this.#holdsEnd()) {
      holdForBody(
        res,
        this.#exchange,
        () => this.#complete(),
        () => this.#stopReadingOnceDrained(),
      )
      return
    }
    res.cork(() => {
      res.end()
    })
    this.#exchange.end()
  }

  #holdsEnd(): boolean {
    return !this.#readingStopped && closesBeforeBodyEnds(this.#exchange)
  }

  #stopReadingOnceDrained(): void {
    this.#stopRequested = true
    if (this.#exchange.closed || this.#blocked) return
    const held = this.#held
    if (held !== undefined && held.bytes.byteLength > 1) {
      this.#held = { bytes: held.bytes.subarray(-1), resolve: held.resolve }
      if (!this.#send(held.bytes.subarray(0, -1))) return
    }
    this.#readingStopped = true
    this.#res.pause()
    if (this.#held === undefined) this.#complete()
    else this.#releaseHeld()
  }

  #hold(bytes: Uint8Array): Promise<boolean> {
    return new Promise(resolve => {
      this.#held = { bytes, resolve }
      holdForBody(
        this.#res,
        this.#exchange,
        () => this.#releaseHeld(),
        () => this.#stopReadingOnceDrained(),
      )
    })
  }

  #releaseHeld(): void {
    const held = this.#held
    this.#held = undefined
    if (held === undefined || this.#exchange.closed) return
    if (this.#blocked) {
      this.#queue.push(held)
      return
    }
    if (this.#send(held.bytes)) held.resolve(true)
    else this.#waiter = held.resolve
  }

  #fail(error: unknown): void {
    this.#returned = true
    logServerError(this.#exchange.runtime.logger, error, this.#context.req.method, this.#context.req.path)
    if (this.#exchange.closed) return
    setImmediate(() => closeConnection(this.#res, this.#exchange))
  }
}
