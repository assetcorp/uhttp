import { parseMediaType } from '../../body/media-type.js'
import { COMPRESSIBLE_TYPES, UNCOMPRESSED_TEXT_TYPES } from './constants.js'

const QUALITY = /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i
const NO_TRANSFORM = /(?:^|,)\s*no-transform\s*(?:,|$)/i

/**
 * Returns `true` when the middleware compresses a body of a content type: every `text/` type
 * apart from `text/event-stream`, every `+json` and `+xml` type, and the types of an allow-list.
 *
 * @param contentType - The middleware passes the content type of the response.
 * @returns The function returns `false` for a missing or malformed content type.
 * @internal
 */
export function compressibleType(contentType: string | undefined): boolean {
  const type = parseMediaType(contentType)?.type
  if (type === undefined) return false
  if (type.startsWith('text/')) return !UNCOMPRESSED_TEXT_TYPES.includes(type)
  return type.endsWith('+json') || type.endsWith('+xml') || COMPRESSIBLE_TYPES.includes(type)
}

/**
 * Returns `true` when a `Cache-Control` header contains the `no-transform` directive.
 *
 * @param lines - The middleware passes the lines of the header.
 * @returns The function returns `false` when the header is missing.
 * @internal
 */
export function forbidsTransform(lines: readonly string[] | undefined): boolean {
  return lines?.some(line => NO_TRANSFORM.test(line)) === true
}

function qualityOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const text = parameter.trim()
    if (!text.toLowerCase().startsWith('q=')) continue
    return QUALITY.test(text) ? Number(text.slice(2)) : 0
  }
  return 1
}

/**
 * Returns the encoding that the middleware compresses with, after it parses `Accept-Encoding` under
 * RFC 9110. The function picks the encoding with the highest quality that the client sent, and it
 * breaks a tie with the order of `encodings`. It treats an entry with a malformed quality as an
 * encoding that the client excludes.
 *
 * @typeParam Encoding - The middleware passes the names of the encodings that it can use.
 * @param header - The middleware passes the `Accept-Encoding` header of the request.
 * @param encodings - The middleware passes the encodings that it can use, in order of preference.
 * @returns The function returns the encoding, or `undefined` when the client excludes all of them.
 * @internal
 */
export function negotiatedEncoding<Encoding extends string>(
  header: string | undefined,
  encodings: readonly Encoding[],
): Encoding | undefined {
  if (header === undefined) return undefined
  const qualities = new Map<string, number>()
  for (const entry of header.split(',')) {
    const [coding = '', ...parameters] = entry.split(';')
    const name = coding.trim().toLowerCase()
    if (name !== '' && !qualities.has(name)) qualities.set(name, qualityOf(parameters))
  }
  const fallback = qualities.get('*') ?? 0
  let chosen: Encoding | undefined
  let best = 0
  for (const encoding of encodings) {
    const quality = qualities.get(encoding) ?? fallback
    if (quality > best) {
      best = quality
      chosen = encoding
    }
  }
  return chosen
}
