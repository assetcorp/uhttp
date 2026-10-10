import { parseParameters } from '../body/index.js'
import { MAX_PART_HEADER_COUNT, MAX_PART_NAME_BYTES } from '../constants.js'
import { UhttpError } from '../errors.js'
import { containsControlCharacter, isToken } from '../headers.js'

const FORM_DATA = 'form-data'
const PATH_SEPARATOR = /[/\\]/
const DOT_SEGMENTS: readonly string[] = ['.', '..']
const decoder = new TextDecoder()

/**
 * The multipart parser takes these values from the headers of each part.
 *
 * @internal
 */
export interface PartHeaders {
  /** The part has this field name from its `Content-Disposition` header. */
  readonly name: string
  /** A file part has this basename, and a field part has `undefined`. */
  readonly filename: string | undefined
  /** The part has this `Content-Type` header, which is `undefined` when the client sent none. */
  readonly contentType: string | undefined
}

function malformed(message: string): UhttpError {
  return new UhttpError('INVALID_MULTIPART', message)
}

function headerStore(text: string): Record<string, string> {
  const store: Record<string, string> = Object.create(null)
  if (text === '') return store
  const lines = text.split('\r\n')
  if (lines.length > MAX_PART_HEADER_COUNT) {
    throw new UhttpError('PAYLOAD_TOO_LARGE', `A multipart part has more than ${MAX_PART_HEADER_COUNT} headers.`)
  }
  for (const line of lines) {
    const colon = line.indexOf(':')
    const name = colon === -1 ? '' : line.slice(0, colon).toLowerCase()
    if (!isToken(name)) throw malformed('A multipart part has a header line without a valid name.')
    if (!(name in store)) store[name] = line.slice(colon + 1).trim()
  }
  return store
}

function hasControlCharacter(text: string): boolean {
  return text.includes('\t') || containsControlCharacter(text, false)
}

function basename(filename: string): string {
  const last = filename.split(PATH_SEPARATOR).at(-1) ?? ''
  return DOT_SEGMENTS.includes(last) ? '' : last
}

/**
 * Returns the field name, the filename, and the content type of one part. The function keeps the
 * headers in a store with no prototype and decodes them as UTF-8, which is what browsers usually
 * send. Of a filename, it keeps only the basename, and it turns a basename of `.` or `..` into an
 * empty name, as busboy does.
 *
 * @param bytes - The parser passes the header block of the part without its blank line.
 * @returns The function returns the headers that the upload needs.
 * @throws {@link UhttpError} with the code `INVALID_MULTIPART` for a part without a `form-data`
 * disposition and a name, or with a control character in its name or its filename, and with the
 * code `PAYLOAD_TOO_LARGE` for more than 16 header lines or a name longer than 256 bytes.
 * @internal
 */
export function parsePartHeaders(bytes: Uint8Array): PartHeaders {
  const store = headerStore(decoder.decode(bytes))
  const disposition = store['content-disposition']
  if (disposition === undefined) throw malformed('A multipart part has no Content-Disposition header.')
  const typeEnd = disposition.search(/[;\s]|$/)
  if (disposition.slice(0, typeEnd).toLowerCase() !== FORM_DATA) {
    throw malformed('A multipart part has a disposition other than form-data.')
  }
  const parameters = parseParameters(disposition, typeEnd, false)
  const name = parameters?.name
  if (parameters === undefined || name === undefined) {
    throw malformed('A multipart part has no field name in its Content-Disposition header.')
  }
  if (Buffer.byteLength(name) > MAX_PART_NAME_BYTES) {
    throw new UhttpError('PAYLOAD_TOO_LARGE', `A multipart field name is longer than ${MAX_PART_NAME_BYTES} bytes.`)
  }
  const filename = parameters.filename
  if (hasControlCharacter(name) || (filename !== undefined && hasControlCharacter(filename))) {
    throw malformed('A multipart field name or filename contains a control character.')
  }
  return {
    name,
    filename: filename === undefined ? undefined : basename(filename),
    contentType: store['content-type'],
  }
}
