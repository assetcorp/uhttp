import { LONGEST_CONTENT_LENGTH_DIGITS } from './constants.js'
import { UhttpError } from './errors.js'
import { isDecimalDigits } from './headers.js'

const CHUNKED = 'chunked'
const ASCII_UPPERCASE = /[A-Z]/g

function asciiLowerCase(text: string): string {
  return text.replace(ASCII_UPPERCASE, letter => letter.toLowerCase())
}

/**
 * Returns `true` when uWebSockets.js v20.71.0 answers a request with its own 400 because of the
 * framing lines of that request. uWebSockets.js calls the handler of the route before it applies most of these
 * checks, so the package applies them first and starts no chain for such a request.
 *
 * @param lengths - The package passes the value of every `content-length` line of the request.
 * @param encodings - The package passes the value of every `transfer-encoding` line of the request.
 * @returns The function returns `true` for a request with both headers, for a first
 * `transfer-encoding` line that does not end with `chunked`, and for `content-length` lines that
 * differ, that hold anything but digits, or whose value has more than
 * {@link LONGEST_CONTENT_LENGTH_DIGITS} characters.
 * @internal
 */
export function parserRejectsFraming(lengths: readonly string[], encodings: readonly string[]): boolean {
  const [encoding] = encodings
  const [length] = lengths
  if (encoding !== undefined) return length !== undefined || !asciiLowerCase(encoding).endsWith(CHUNKED)
  if (length === undefined) return false
  if (length.length > LONGEST_CONTENT_LENGTH_DIGITS || !isDecimalDigits(length)) return true
  return lengths.some(other => other !== length)
}

/**
 * Returns the error with which the package rejects the `transfer-encoding` lines of a request that
 * uWebSockets.js accepts, because uWebSockets.js decodes the body as `chunked` alone whenever the
 * value ends with `chunked`.
 *
 * @param encodings - The package passes the value of every `transfer-encoding` line of the request.
 * @returns The function returns `UNSUPPORTED_TRANSFER_CODING` when another coding comes before a
 * single `chunked`, `INVALID_TRANSFER_ENCODING` when the last coding is another coding or `chunked`
 * appears twice, and `undefined` for `chunked` alone or for a request without the header.
 * @internal
 */
export function transferCodingError(encodings: readonly string[]): UhttpError | undefined {
  if (encodings.length === 0) return undefined
  const codings = encodings
    .flatMap(line => line.split(','))
    .map(coding => asciiLowerCase(coding.trim()))
    .filter(coding => coding !== '')
  const chunkedCount = codings.filter(coding => coding === CHUNKED).length
  if (codings.length === 1 && chunkedCount === 1) return undefined
  if (codings.at(-1) === CHUNKED && chunkedCount === 1) {
    return new UhttpError(
      'UNSUPPORTED_TRANSFER_CODING',
      'Send the request body with the chunked transfer coding alone, because the server decodes no other.',
    )
  }
  return new UhttpError(
    'INVALID_TRANSFER_ENCODING',
    'The transfer-encoding of a request must list chunked once, as its last coding.',
  )
}
