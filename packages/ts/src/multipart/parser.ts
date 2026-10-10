import { MAX_PART_HEADER_BYTES } from '../constants.js'
import { UhttpError } from '../errors.js'
import { type PartHeaders, parsePartHeaders } from './part.js'

const CR = 0x0d
const LF = 0x0a
const DASH = 0x2d
const CRLF = Buffer.from('\r\n')
const HEADER_END = Buffer.from('\r\n\r\n')
const EMPTY = Buffer.alloc(0)

type State = 'preamble' | 'boundary' | 'headers' | 'body' | 'done'

/**
 * The multipart parser reports each part through these events, in order: the headers, any number
 * of data chunks, and the end.
 *
 * @internal
 */
export type PartEvent =
  | { readonly kind: 'headers'; readonly headers: PartHeaders }
  | { readonly kind: 'data'; readonly bytes: Uint8Array }
  | { readonly kind: 'end' }

function malformed(message: string): UhttpError {
  return new UhttpError('INVALID_MULTIPART', message)
}

/**
 * The package parses a `multipart/form-data` body with this state machine, which follows busboy's
 * design. In the preamble and in each part, it searches for `CRLF--boundary` with the native
 * `indexOf`. When the tail of a chunk could start a boundary, the parser copies that tail in front
 * of the next chunk, so that it finds a boundary that two chunks split between them. The parser
 * treats a boundary followed by anything other than `--` or `CRLF` as data, as busboy does.
 *
 * @internal
 */
export class MultipartParser {
  readonly #needle: Buffer
  #state: State = 'preamble'
  #boundaryFrom: State = 'preamble'
  #carry: Buffer = CRLF
  #headers: Buffer = CRLF

  /**
   * Creates the parser of one body.
   *
   * @param boundary - The package passes the boundary from the content type, which it has checked.
   */
  constructor(boundary: string) {
    this.#needle = Buffer.from(`\r\n--${boundary}`)
  }

  /** This is `true` once the parser has read the closing boundary. */
  get done(): boolean {
    return this.#state === 'done'
  }

  /**
   * Parses one chunk and reports every event that it completes.
   *
   * @param chunk - The package passes the next chunk of the body.
   * @param emit - The parser calls this function for each event, with data that remains valid after
   * the call returns.
   * @throws {@link UhttpError} with the code `INVALID_MULTIPART` or `PAYLOAD_TOO_LARGE` when the
   * headers of a part are malformed or pass a limit.
   */
  push(chunk: Uint8Array, emit: (event: PartEvent) => void): void {
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const buffer = this.#carry.byteLength === 0 ? input : Buffer.concat([this.#carry, input])
    this.#carry = EMPTY
    let position = 0
    while (position < buffer.byteLength && this.#state !== 'done') {
      if (this.#state === 'boundary') position = this.#afterBoundary(buffer, position, emit)
      else if (this.#state === 'headers') position = this.#readHeaders(buffer, position, emit)
      else position = this.#search(buffer, position, emit)
    }
  }

  /**
   * Checks that the body ended at its closing boundary.
   *
   * @throws {@link UhttpError} with the code `INVALID_MULTIPART` when the body ended before it.
   */
  finish(): void {
    if (this.#state !== 'done') throw malformed('The multipart body ended before its closing boundary.')
  }

  #search(buffer: Buffer, position: number, emit: (event: PartEvent) => void): number {
    const inBody = this.#state === 'body'
    const match = buffer.indexOf(this.#needle, position)
    if (match !== -1) {
      if (inBody && match > position) emit({ kind: 'data', bytes: buffer.subarray(position, match) })
      this.#boundaryFrom = this.#state
      this.#state = 'boundary'
      return match + this.#needle.byteLength
    }
    const kept = this.#partialMatch(buffer, position)
    const end = buffer.byteLength - kept
    if (inBody && end > position) emit({ kind: 'data', bytes: buffer.subarray(position, end) })
    this.#carry = buffer.subarray(end)
    return buffer.byteLength
  }

  #partialMatch(buffer: Buffer, position: number): number {
    const needle = this.#needle
    const longest = Math.min(needle.byteLength - 1, buffer.byteLength - position)
    for (let length = longest; length > 0; length--) {
      const start = buffer.byteLength - length
      if (buffer[start] !== CR) continue
      if (buffer.subarray(start).equals(needle.subarray(0, length))) return length
    }
    return 0
  }

  #afterBoundary(buffer: Buffer, position: number, emit: (event: PartEvent) => void): number {
    if (buffer.byteLength - position < 2) {
      this.#carry = buffer.subarray(position)
      return buffer.byteLength
    }
    const first = buffer[position]
    const second = buffer[position + 1]
    const closing = first === DASH && second === DASH
    if (closing || (first === CR && second === LF)) {
      if (this.#boundaryFrom === 'body') emit({ kind: 'end' })
      this.#state = closing ? 'done' : 'headers'
      this.#headers = CRLF
      return position + 2
    }
    if (this.#boundaryFrom === 'body') emit({ kind: 'data', bytes: this.#needle })
    this.#state = this.#boundaryFrom
    return position
  }

  #readHeaders(buffer: Buffer, position: number, emit: (event: PartEvent) => void): number {
    const room = MAX_PART_HEADER_BYTES + HEADER_END.byteLength + CRLF.byteLength - this.#headers.byteLength
    const slice = buffer.subarray(position, position + room)
    const joined = Buffer.concat([this.#headers, slice])
    const end = joined.indexOf(HEADER_END, Math.max(0, this.#headers.byteLength - (HEADER_END.byteLength - 1)))
    if (end === -1) {
      const pending = joined.byteLength - CRLF.byteLength - (HEADER_END.byteLength - 1)
      if (pending > MAX_PART_HEADER_BYTES) throw headersTooLarge()
      this.#headers = joined
      return position + slice.byteLength
    }
    if (end - CRLF.byteLength > MAX_PART_HEADER_BYTES) throw headersTooLarge()
    const consumed = end + HEADER_END.byteLength - this.#headers.byteLength
    emit({
      kind: 'headers',
      headers: parsePartHeaders(joined.subarray(CRLF.byteLength, Math.max(end, CRLF.byteLength))),
    })
    this.#headers = CRLF
    this.#state = 'body'
    return position + consumed
  }
}

function headersTooLarge(): UhttpError {
  return new UhttpError(
    'PAYLOAD_TOO_LARGE',
    `The headers of a multipart part take more than ${MAX_PART_HEADER_BYTES} bytes.`,
  )
}
