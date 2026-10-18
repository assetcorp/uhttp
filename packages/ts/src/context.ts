import { DEFAULT_REDIRECT_STATUS, REDIRECT_STATUSES } from './constants.js'
import { UhttpError } from './errors.js'
import type { Exchange } from './exchange.js'
import { checkedHeaderValue, type HeaderRecord, headerLinesOf } from './headers.js'
import { createReply, JSON_CONTENT_TYPE, type Reply, type StreamProducer, TEXT_CONTENT_TYPE } from './reply.js'
import type { RequestInfo } from './request.js'
import { type EventStreamOptions, type EventStreamProducer, eventStreamReply } from './sse.js'

const BYTES_CONTENT_TYPE = 'application/octet-stream'

/**
 * You pass these options to {@link Context.stream} to set the status, the headers, the content
 * type, and the length of a streamed response.
 */
export interface StreamOptions {
  /** When you leave out the status, the package sends 200. */
  readonly status?: number
  /** The package sends these headers with the stream. */
  readonly headers?: HeaderRecord
  /** When you leave out the content type, the package sends `application/octet-stream`. */
  readonly contentType?: string
  /**
   * When you declare the length in bytes, the package sends a `content-length` header, and it
   * closes the connection if your producer writes a different number of bytes. Without a length,
   * the package sends a chunked body.
   */
  readonly length?: number
}

/**
 * You pass these options to {@link Context.header}.
 */
export interface HeaderOptions {
  /** When this is `true`, the package adds a line to the header and keeps its earlier lines. */
  readonly append?: boolean
}

let construct: (request: RequestInfo, exchange: Exchange) => Context
let readValues: (context: Context) => Record<string, unknown>
let readExchange: (context: Context) => Exchange

/**
 * Every middleware and handler receives a `Context`, which has the copied request in `req` and
 * the helpers that build a reply.
 */
export class Context {
  /** The package copies these parts of the request before the first `await`. */
  readonly req: RequestInfo
  readonly #exchange: Exchange
  #values: Map<string, unknown> | undefined

  static {
    construct = (request, exchange) => new Context(request, exchange)
    readValues = context => {
      const values: Record<string, unknown> = Object.create(null)
      for (const [key, value] of context.#values ?? []) values[key] = value
      return values
    }
    readExchange = context => context.#exchange
  }

  private constructor(request: RequestInfo, exchange: Exchange) {
    this.req = request
    this.#exchange = exchange
  }

  /**
   * This is the current reply of the request, which a middleware can inspect after `await next()`.
   * It is `undefined` until a handler or a middleware has returned a reply.
   */
  get reply(): Reply | undefined {
    return this.#exchange.reply
  }

  /**
   * Stores a value under a key for the rest of the request, so that a middleware can look up a
   * value once, such as the signed-in user, and every later middleware and the handler can get it
   * with {@link Context.get}. On a WebSocket route, the package copies the values that your code
   * stores during the upgrade into the `data` of the socket.
   *
   * @param key - You choose the key, and a later call with the same key replaces the value.
   * @param value - The package stores this value as it is.
   */
  set(key: string, value: unknown): void {
    this.#values ??= new Map()
    this.#values.set(key, value)
  }

  /**
   * Returns the value that a middleware or the handler stored under a key with
   * {@link Context.set}.
   *
   * @param key - You pass the key under which your code stored the value.
   * @returns The method returns the value, or `undefined` when your code has stored nothing under
   * the key.
   */
  get(key: string): unknown {
    return this.#values?.get(key)
  }

  /**
   * Sets a response header, which the package sends with whatever reply the request ends with,
   * including an error reply. The package drops `content-length`, `transfer-encoding`,
   * `connection`, and `date`, because it sets the framing itself.
   *
   * @param name - The name must be an HTTP token.
   * @param value - The value must contain no line break, no NUL, and no other control character
   * apart from a tab.
   * @param options - When you set `append`, the package keeps the earlier lines of the header.
   * @throws {@link UhttpError} with the code `INVALID_HEADER` when the name or the value fails its
   * check.
   */
  header(name: string, value: string, options?: HeaderOptions): void {
    this.#exchange.response.setHeader(name, value, options?.append === true)
  }

  /**
   * Returns a reply whose body is the text that you pass and whose content type is
   * `text/plain; charset=UTF-8`.
   *
   * @param body - The package sends this text as the body.
   * @param status - When you leave out the status, the package sends 200.
   * @param headers - The package sends these headers with the reply.
   * @returns Your handler returns this reply.
   * @throws {@link UhttpError} with the code `INVALID_STATUS` for a status outside 200 to 599, or
   * with the code `INVALID_HEADER` when a header fails its check.
   */
  text(body: string, status = 200, headers?: HeaderRecord): Reply {
    return createReply(status, TEXT_CONTENT_TYPE, body, headerLinesOf(headers))
  }

  /**
   * Returns a reply whose body is the JSON text of the value that you pass and whose content type
   * is `application/json`.
   *
   * @param value - `JSON.stringify` converts this value, and the package sends `null` in place of
   * `undefined`.
   * @param status - When you leave out the status, the package sends 200.
   * @param headers - The package sends these headers with the reply.
   * @returns Your handler returns this reply.
   * @throws {@link UhttpError} with the code `INVALID_STATUS` for a status outside 200 to 599, or
   * with the code `INVALID_HEADER` when a header fails its check.
   */
  json(value: unknown, status = 200, headers?: HeaderRecord): Reply {
    return createReply(status, JSON_CONTENT_TYPE, JSON.stringify(value) ?? 'null', headerLinesOf(headers))
  }

  /**
   * Returns a reply whose body is the bytes that you pass. Its content type is
   * `application/octet-stream` unless the headers set another.
   *
   * @param data - The package sends these bytes as the body.
   * @param status - When you leave out the status, the package sends 200.
   * @param headers - The package sends these headers with the reply.
   * @returns Your handler returns this reply.
   * @throws {@link UhttpError} with the code `INVALID_STATUS` for a status outside 200 to 599, or
   * with the code `INVALID_HEADER` when a header fails its check.
   */
  bytes(data: Uint8Array | ArrayBuffer, status = 200, headers?: HeaderRecord): Reply {
    const body = data instanceof Uint8Array ? data : new Uint8Array(data)
    return createReply(status, BYTES_CONTENT_TYPE, body, headerLinesOf(headers))
  }

  /**
   * Returns a reply with no body that sends the client to another location.
   *
   * @param location - The package sends this URL as the `location` header.
   * @param status - The status must be 301, 302, 303, 307, or 308, and the package sends 302 when
   * you leave it out.
   * @param headers - The package sends these headers with the reply.
   * @returns Your handler returns this reply.
   * @throws {@link UhttpError} with the code `INVALID_STATUS` for any other status, or with the code
   * `INVALID_HEADER` when the location or a header contains a control character.
   */
  redirect(location: string, status: number = DEFAULT_REDIRECT_STATUS, headers?: HeaderRecord): Reply {
    if (!REDIRECT_STATUSES.includes(status)) {
      throw new UhttpError(
        'INVALID_STATUS',
        `A redirect must have one of the statuses ${REDIRECT_STATUSES.join(', ')}, and your code passed ${status}.`,
      )
    }
    const lines = headerLinesOf(headers) ?? new Map<string, string[]>()
    lines.set('location', [checkedHeaderValue('location', location)])
    return createReply(status, undefined, null, lines)
  }

  /**
   * Returns a streamed reply. The package sends its headers and calls the producer only after the
   * whole middleware chain has returned, so that a middleware can still add headers to the stream.
   * For a HEAD request, the package never calls the producer.
   *
   * @param produce - The package calls this producer with the stream that it writes to.
   * @param options - You can set the status, the headers, the content type, and the length here.
   * @returns Your handler returns this reply.
   * @throws {@link UhttpError} with the code `INVALID_STREAM` when the length is not a whole number
   * of zero or more, with the code `INVALID_STATUS` for a status outside 200 to 599, or with the
   * code `INVALID_HEADER` when the content type or a header fails its check.
   */
  stream(produce: StreamProducer, options: StreamOptions = {}): Reply {
    const { status = 200, headers, contentType = BYTES_CONTENT_TYPE, length } = options
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      throw new UhttpError(
        'INVALID_STREAM',
        `The length of a stream must be a whole number of zero or more, and your code passed ${length}.`,
      )
    }
    return createReply(status, checkedHeaderValue('content-type', contentType), null, headerLinesOf(headers), {
      produce,
      length,
    })
  }

  /**
   * Returns a reply that streams server-sent events with the content type `text/event-stream`. The
   * package sends a heartbeat comment every 30 seconds by default.
   *
   * @param produce - The package calls this producer with the event stream that it sends events on.
   * @param options - You can set the status, the headers, and the heartbeat interval here.
   * @returns Your handler returns this reply.
   * @throws {@link UhttpError} with the code `INVALID_STREAM` when the heartbeat interval is not a
   * whole number of milliseconds of zero or more, with the code `INVALID_STATUS` for a status outside
   * 200 to 599, or with the code `INVALID_HEADER` when a header fails its check.
   */
  sse(produce: EventStreamProducer, options: EventStreamOptions = {}): Reply {
    return eventStreamReply(produce, options)
  }
}

/**
 * Returns the context of one request.
 *
 * @param request - The package passes the copy of the request.
 * @param exchange - The package passes the state of the request.
 * @returns The function returns the context that the chain receives.
 * @internal
 */
export function createContext(request: RequestInfo, exchange: Exchange): Context {
  return construct(request, exchange)
}

/**
 * Returns a new object with every value that your code stored on a context with
 * {@link Context.set}. The object has no prototype, so a key such as `__proto__` stays an ordinary
 * key.
 *
 * @param context - The package passes the context of an upgrade request.
 * @returns The function returns an empty object when your code stored nothing.
 * @internal
 */
export function contextValues(context: Context): Record<string, unknown> {
  return readValues(context)
}

/**
 * Returns the state of the request behind a context, so that a middleware of the package can read
 * the response headers, replace the reply with a changed copy of it, and wait for the end of the
 * response.
 *
 * @param context - The middleware passes the context of the request.
 * @returns The function returns the state of the request.
 * @internal
 */
export function exchangeOf(context: Context): Exchange {
  return readExchange(context)
}
