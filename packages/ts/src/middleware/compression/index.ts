import { type Context, exchangeOf } from '../../context.js'
import type { Exchange } from '../../exchange.js'
import { createReply, type Reply } from '../../reply.js'
import { hasResponseHeader, type PreparedName, responseContentType, responseHeaderLines } from '../../response.js'
import type { MiddlewareDefinition } from '../../types.js'
import { fixedHeader, fixedName, invalidOption, optionsObject, wholeNumberOption } from '../options.js'
import {
  ACCEPT_ENCODING_HEADER,
  CACHE_CONTROL_HEADER,
  CONTENT_ENCODING_HEADER,
  DEFAULT_COMPRESSION_ENCODINGS,
  DEFAULT_COMPRESSION_THRESHOLD_BYTES,
  ETAG_HEADER,
  MAX_COMPRESSION_THRESHOLD_BYTES,
  UNCOMPRESSED_STATUSES,
  VARY_HEADER,
} from './constants.js'
import { type CompressionEncoding, compressBody, compressedProducer, encodingAvailable } from './encode.js'
import { compressibleType, forbidsTransform, negotiatedEncoding } from './negotiate.js'

export type { CompressionEncoding } from './encode.js'

/**
 * You pass these options to {@link compression}.
 */
export interface CompressionOptions {
  /** The middleware compresses a body of at least this many bytes, which is 1,024 by default. */
  readonly threshold?: number
  /**
   * The middleware picks from these encodings in this order of preference, which is `br`, `zstd`,
   * and `gzip` by default. It skips `zstd` on a version of Node without zstd.
   */
  readonly encodings?: readonly CompressionEncoding[]
}

const skipped = new WeakSet<Context>()

function isEncoding(value: unknown): value is CompressionEncoding {
  return typeof value === 'string' && DEFAULT_COMPRESSION_ENCODINGS.includes(value)
}

function checkedEncodings(value: unknown): CompressionEncoding[] {
  const list: unknown = value ?? DEFAULT_COMPRESSION_ENCODINGS
  if (!Array.isArray(list) || list.length === 0 || !list.every(isEncoding)) {
    throw invalidOption("Set the encodings option of compression() to a list of 'br', 'zstd', and 'gzip'.")
  }
  return list.filter(encodingAvailable)
}

function copiedHeaders(headers: Reply['headers']): Map<string, string[]> | undefined {
  if (headers === undefined) return undefined
  const copy = new Map<string, string[]>()
  for (const [name, lines] of headers) copy.set(name, [...lines])
  return copy
}

async function compressedReply(
  reply: Reply,
  encoding: CompressionEncoding,
  threshold: number,
): Promise<Reply | undefined> {
  const { stream, body } = reply
  if (stream !== undefined) {
    if (stream.length !== undefined && stream.length < threshold) return undefined
    return createReply(reply.status, reply.contentType, null, copiedHeaders(reply.headers), {
      produce: compressedProducer(stream.produce, encoding),
      length: undefined,
    })
  }
  if (body === null) return undefined
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  if (bytes.byteLength < threshold) return undefined
  const compressed = await compressBody(encoding, bytes)
  return createReply(reply.status, reply.contentType, compressed, copiedHeaders(reply.headers))
}

function weakenTag(exchange: Exchange, tagName: PreparedName): void {
  const tag = responseHeaderLines(exchange, ETAG_HEADER)?.at(-1)
  if (tag !== undefined && !tag.startsWith('W/')) exchange.setPrepared(tagName, `W/${tag}`, false)
}

/**
 * Leaves the response of a request uncompressed, for a route whose client must receive the body
 * byte for byte, or whose body contains a secret next to text that an attacker controls.
 *
 * @param context - You pass the context of the request.
 */
export function skipCompression(context: Context): void {
  skipped.add(context)
}

/**
 * Returns a middleware that compresses a response with Brotli at quality 4, with zstd on a version
 * of Node that has it, or with gzip, according to the encodings that the client lists in the
 * `Accept-Encoding` header of the request. The middleware compresses only bodies of 1,024 bytes or
 * more whose type is text, JSON, XML, JavaScript, or SVG, and it leaves out `text/event-stream`. It
 * compresses a streamed reply chunk by chunk and sends it chunked.
 *
 * The middleware leaves a response unchanged when its status is 204, 206, or 304, when it already
 * has `Content-Encoding` or has `Cache-Control: no-transform`, or when you called
 * {@link skipCompression} on the route. It adds `Vary: Accept-Encoding` to every other response of
 * a compressible type, including the response to a HEAD request, which it never compresses. It
 * turns a strong `ETag` into a weak one when it compresses the body.
 *
 * When a compressed response contains a secret next to text from the request, an attacker who
 * observes the size of the responses can guess the secret, as in the BREACH attack. Call
 * {@link skipCompression} on such a route. When a proxy forwards requests to your servers, let the
 * proxy compress the responses, so that your server spends no CPU time on compression.
 *
 * @param options - You can change the threshold and the order of the encodings.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when `threshold` is not a
 * whole number from 0 to 1,073,741,824, or when `encodings` is not a list of `br`, `zstd`, and
 * `gzip`.
 */
export function compression(options?: CompressionOptions): MiddlewareDefinition {
  const checked = optionsObject(options, 'compression()')
  const threshold = wholeNumberOption(
    Reflect.get(checked, 'threshold') ?? DEFAULT_COMPRESSION_THRESHOLD_BYTES,
    'the threshold option of compression()',
    0,
    MAX_COMPRESSION_THRESHOLD_BYTES,
  )
  const encodings = checkedEncodings(Reflect.get(checked, 'encodings'))
  const vary = fixedHeader(VARY_HEADER, 'Accept-Encoding')
  const contentEncodings = new Map(
    encodings.map(encoding => [encoding, fixedHeader(CONTENT_ENCODING_HEADER, encoding)]),
  )
  const tagName = fixedName(ETAG_HEADER)
  return {
    headers: [ACCEPT_ENCODING_HEADER],
    async handle(context, next) {
      await next()
      if (skipped.has(context)) return
      const exchange = exchangeOf(context)
      const reply = exchange.reply
      if (
        reply === undefined ||
        UNCOMPRESSED_STATUSES.includes(reply.status) ||
        hasResponseHeader(exchange, CONTENT_ENCODING_HEADER) ||
        forbidsTransform(responseHeaderLines(exchange, CACHE_CONTROL_HEADER)) ||
        !compressibleType(responseContentType(exchange))
      ) {
        return
      }
      exchange.setFixed(vary, true)
      if (context.req.method === 'HEAD') return
      const encoding = negotiatedEncoding(context.req.header(ACCEPT_ENCODING_HEADER), encodings)
      const contentEncoding = encoding === undefined ? undefined : contentEncodings.get(encoding)
      if (encoding === undefined || contentEncoding === undefined) return
      const replacement = await compressedReply(reply, encoding, threshold)
      if (replacement === undefined) return
      exchange.substitute(replacement)
      exchange.setFixed(contentEncoding, false)
      weakenTag(exchange, tagName)
    },
  }
}
