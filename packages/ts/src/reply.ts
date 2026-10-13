import { BODYLESS_STATUSES, MAX_REPLY_STATUS, MIN_REPLY_STATUS, SWITCHING_PROTOCOLS_STATUS } from './constants.js'
import { UhttpError } from './errors.js'
import type { HeaderLines } from './headers.js'

/**
 * The package sends this content type with a JSON reply.
 *
 * @internal
 */
export const JSON_CONTENT_TYPE = 'application/json'

/**
 * The package sends this content type with a text reply.
 *
 * @internal
 */
export const TEXT_CONTENT_TYPE = 'text/plain; charset=UTF-8'

/**
 * Returns the error that a stream write must reject with, or `undefined` when the write can go
 * ahead.
 *
 * @param returned - The package passes `true` when the producer has already returned.
 * @param accepted - The package passes the number of bytes that the stream accepted before this write.
 * @param bytes - The package passes the size of this write in bytes.
 * @param length - You declared this length in bytes, and it is `undefined` for a chunked body.
 * @returns The function returns a {@link UhttpError} with the code `INVALID_STREAM` when the
 * producer has returned or when the write would take the body past the declared length.
 * @internal
 */
export function streamWriteError(
  returned: boolean,
  accepted: number,
  bytes: number,
  length: number | undefined,
): UhttpError | undefined {
  if (returned) return new UhttpError('INVALID_STREAM', 'The stream producer wrote after it had returned.')
  if (length !== undefined && accepted + bytes > length) {
    return new UhttpError('INVALID_STREAM', 'The stream producer wrote more bytes than the length that it declared.')
  }
  return undefined
}

/**
 * Returns the error that the package logs when a producer returns before it has written the
 * declared length, or `undefined` when the body is complete.
 *
 * @param accepted - The package passes the number of bytes that the stream accepted.
 * @param length - You declared this length in bytes, and it is `undefined` for a chunked body.
 * @returns The function returns a {@link UhttpError} with the code `INVALID_STREAM` for a short body.
 * @internal
 */
export function streamShortfallError(accepted: number, length: number | undefined): UhttpError | undefined {
  if (length === undefined || accepted >= length) return undefined
  return new UhttpError('INVALID_STREAM', 'The stream producer returned before it wrote the length that it declared.')
}

/**
 * Your stream producer writes the body of a streamed response through this object.
 */
export interface ResponseStream {
  /**
   * Sends one chunk of the body. The promise that the method returns stays pending while the client
   * reads slowly.
   *
   * @param chunk - The package sends a string as UTF-8.
   * @returns The promise resolves to `true` once the package has written the chunk to the socket, or
   * to `false` once the client has gone, so that your producer can stop. It rejects with a
   * {@link UhttpError} with the code `INVALID_STREAM` when the chunk would take the body past the
   * length that you declared, or when your producer has already returned.
   */
  write(chunk: string | Uint8Array): Promise<boolean>
  /**
   * Adds a function that the package calls once, when the client goes or the response ends.
   *
   * @param listener - The package calls this function once.
   */
  onClose(listener: () => void): void
  /** This is `true` once the client has gone or the response has ended. */
  readonly closed: boolean
}

/**
 * A stream producer writes the body of a streamed response and returns once the body is complete.
 *
 * @param stream - The package passes the stream that your producer writes to.
 * @returns The producer returns nothing, or a promise that settles once the body is complete. When
 * the promise rejects, the package closes the connection, so that the client can detect the
 * truncated body.
 */
export type StreamProducer = (stream: ResponseStream) => void | Promise<void>

/**
 * A streamed reply has this producer and, where you declared one, a length in bytes.
 */
export interface ReplyStream {
  /** The package calls this producer once the whole middleware chain has returned. */
  readonly produce: StreamProducer
  /** The package sends a body of exactly this many bytes, or a chunked body when this is `undefined`. */
  readonly length: number | undefined
}

let construct: (
  status: number,
  contentType: string | undefined,
  body: string | Uint8Array | null,
  headers: HeaderLines | undefined,
  stream: ReplyStream | undefined,
) => Reply

let constructSwitch: () => Reply

/**
 * You get a `Reply` from a helper on the {@link Context}, such as {@link Context.json}, and your
 * handler returns it so that the package can write it to the client.
 */
export class Reply {
  /**
   * The HTTP status is a whole number from 200 to 599, apart from the 101 that the package sets
   * when it accepts the upgrade of a WebSocket route.
   */
  readonly status: number
  /** The package sends this value as the `content-type` header, and it sends none when this is `undefined`. */
  readonly contentType: string | undefined
  /** The package sends this body, except in reply to a HEAD request and with a 204, a 205, or a 304. */
  readonly body: string | Uint8Array | null
  /** The package sends these header lines with the reply, keyed by lowercase name. */
  readonly headers: ReadonlyMap<string, readonly string[]> | undefined
  /** A streamed reply has a producer in place of a body. */
  readonly stream: ReplyStream | undefined

  static {
    construct = (status, contentType, body, headers, stream) => new Reply(status, contentType, body, headers, stream)
    constructSwitch = () => new Reply(SWITCHING_PROTOCOLS_STATUS, undefined, null, undefined, undefined, true)
  }

  private constructor(
    status: number,
    contentType: string | undefined,
    body: string | Uint8Array | null,
    headers: HeaderLines | undefined,
    stream: ReplyStream | undefined,
    switching = false,
  ) {
    const valid = Number.isInteger(status) && status >= MIN_REPLY_STATUS && status <= MAX_REPLY_STATUS
    if (!valid && !switching) {
      throw new UhttpError(
        'INVALID_STATUS',
        `The status of a reply must be a whole number from ${MIN_REPLY_STATUS} to ${MAX_REPLY_STATUS}, and the code passed ${status}.`,
      )
    }
    this.status = status
    this.contentType = contentType
    this.body = body
    this.headers = headers
    this.stream = stream
  }
}

/**
 * Returns a new reply, with the content type from the header lines when they contain one.
 *
 * @param status - The HTTP status must be a whole number from 200 to 599.
 * @param contentType - The package sends this content type unless the header lines contain another.
 * @param body - The package sends this body.
 * @param headers - The package sends these checked header lines.
 * @param stream - A streamed reply has a producer in place of a body.
 * @returns The function returns the reply.
 * @throws {@link UhttpError} with the code `INVALID_STATUS` when the status is a fraction, below
 * 200, or above 599.
 * @internal
 */
export function createReply(
  status: number,
  contentType: string | undefined,
  body: string | Uint8Array | null,
  headers?: HeaderLines,
  stream?: ReplyStream,
): Reply {
  const typeLines = headers?.get('content-type')
  if (headers === undefined || typeLines === undefined) return construct(status, contentType, body, headers, stream)
  headers.delete('content-type')
  return construct(status, typeLines.at(-1), body, headers.size === 0 ? undefined : headers, stream)
}

/**
 * Returns the reply with the status 101 that the last handler of a WebSocket route returns once
 * every check of the upgrade request has passed. When the request ends with this reply, the
 * package switches the connection to a WebSocket. When a middleware returns another reply in its
 * place, the package sends that reply.
 *
 * @returns The function returns a reply without a body. No helper on the context returns a reply
 * with this status.
 * @internal
 */
export function switchingReply(): Reply {
  return constructSwitch()
}

/**
 * Returns `true` when the package sends a body with a reply of this status, which it does for
 * every status apart from 204, 205, and 304.
 *
 * @param status - The function checks this status.
 * @returns The function returns `false` for a 204, a 205, or a 304.
 * @internal
 */
export function statusHasBody(status: number): boolean {
  return !BODYLESS_STATUSES.includes(status)
}

/**
 * Returns the length of a body in bytes, counting a string as UTF-8.
 *
 * @param body - The body of a reply.
 * @returns The function returns 0 for `null`.
 * @internal
 */
export function bodyByteLength(body: string | Uint8Array | null): number {
  if (body === null) return 0
  return typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
}

/**
 * Returns the reply that the default handlers send for an error, as `{ error: { code, message } }`,
 * with `issues` added for an error that lists validation problems.
 *
 * @param error - The function puts the status, the code, the message, and the problems of this error into the reply.
 * @returns The function returns a JSON reply.
 * @internal
 */
export function errorReply({ status, code, message, issues }: UhttpError): Reply {
  const error = issues === undefined ? { code, message } : { code, message, issues }
  return construct(status, JSON_CONTENT_TYPE, JSON.stringify({ error }), undefined, undefined)
}
