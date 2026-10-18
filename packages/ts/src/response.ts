import type { Reply } from './reply.js'

const CONTENT_TYPE = 'content-type'

/**
 * The package passes a fixed header to uWebSockets.js as these bytes, which a middleware builds
 * once with `headerBytes`, because uWebSockets.js uses the bytes of an `ArrayBuffer` without a
 * conversion.
 *
 * @internal
 */
export interface EncodedHeader {
  /** These bytes are the lowercase name of the header. */
  readonly name: ArrayBuffer
  /**
   * These bytes are the value of the header, or this is `undefined` for a value that a middleware
   * builds for each request, which the package passes to uWebSockets.js as text.
   */
  readonly value: ArrayBuffer | undefined
}

/**
 * A middleware checks and encodes the name of a response header in this form once, at startup, so
 * that it can send a value that it builds for each request under that name.
 *
 * @internal
 */
export interface PreparedName {
  /** The middleware checked this lowercase name, which is the name of no framing header. */
  readonly name: string
  /** The package passes these bytes to uWebSockets.js. */
  readonly encoded: EncodedHeader
}

/**
 * A middleware checks and encodes a whole response header in this form once, at startup.
 *
 * @internal
 */
export interface PreparedHeader extends PreparedName {
  /** The middleware checked this value, and the encoded bytes contain the same value. */
  readonly value: string
}

/**
 * The package calls a function of this type for each line of a response header.
 *
 * @param name - The package passes the lowercase name of the header.
 * @param value - The package passes the value of the line.
 * @param encoded - The package passes the bytes of a fixed line, or `undefined` for any other line.
 * @internal
 */
export type HeaderVisitor = (name: string, value: string, encoded: EncodedHeader | undefined) => void

/**
 * The package keeps one response header that code set through the context in this form.
 *
 * @internal
 */
export interface SetHeader {
  /** The package sends these lines of the header in order. */
  readonly lines: string[]
  /** This list contains the bytes of each fixed line at the index of that line, and it contains `undefined` at the index of any other line. */
  readonly encodings: (EncodedHeader | undefined)[]
  /** This is `true` when your code appended the header, so the package sends it after the lines of the reply under the same name. */
  readonly appends: boolean
  /** This number is the place of the last line in the count of replies and headers of the request. */
  setAt: number
}

/**
 * The package keeps the response headers that code set through the context in this map, under
 * their lowercase names.
 *
 * @internal
 */
export type SetHeaders = Map<string, SetHeader>

/**
 * The package reads the current reply of a request and the response headers that code set through
 * the context from the state of the request in this form.
 *
 * @internal
 */
export interface ResponseParts {
  /** The chain has produced this reply so far, and it is `undefined` before any reply exists. */
  readonly reply: Reply | undefined
  /** This number is the place of the current reply in the count of replies and headers of the request. */
  readonly replySetAt: number
  /** The package keeps the headers that code set through the context here, and this is `undefined` until code sets one. */
  readonly setHeaders: SetHeaders | undefined
}

/**
 * Stores one line of a response header that code set through the context.
 *
 * @param headers - The package passes the headers that code set so far, or `undefined` when code set none.
 * @param lowerName - The package passes the checked lowercase name of the header.
 * @param value - The package passes the checked value of the line.
 * @param encoded - The package passes the bytes of a fixed line, or `undefined` for any other line.
 * @param append - When this is `true`, the package keeps the earlier lines of the header.
 * @param setAt - The package passes the place of the line in the count of replies and headers.
 * @returns The function returns the map that contains the line, which it creates when code set no header before.
 * @internal
 */
export function storeHeader(
  headers: SetHeaders | undefined,
  lowerName: string,
  value: string,
  encoded: EncodedHeader | undefined,
  append: boolean,
  setAt: number,
): SetHeaders {
  const stored = headers ?? new Map<string, SetHeader>()
  const existing = stored.get(lowerName)
  if (append && existing !== undefined) {
    existing.lines.push(value)
    existing.encodings.push(encoded)
    existing.setAt = setAt
    return stored
  }
  stored.set(lowerName, { lines: [value], encodings: [encoded], appends: append, setAt })
  return stored
}

/**
 * Returns the content type that the package sends with the current reply. When your code set a
 * `content-type` header after the chain produced the reply, the package sends that header in place
 * of the content type of the reply.
 *
 * @param parts - The package passes the state of the request.
 * @returns The function returns the content type, or `undefined` when neither the reply nor your
 * code set one.
 * @internal
 */
export function responseContentType(parts: ResponseParts): string | undefined {
  const set = parts.setHeaders?.get(CONTENT_TYPE)
  const replyType = parts.reply?.contentType
  if (set !== undefined && (replyType === undefined || set.setAt > parts.replySetAt)) return set.lines.at(-1)
  return replyType
}

/**
 * Returns `true` when the package sends at least one line of a header with the current reply,
 * whether the reply or your code set it.
 *
 * @param parts - The package passes the state of the request.
 * @param lowerName - The caller passes the lowercase name of the header.
 * @returns The function returns `false` when neither the reply nor your code set the header.
 * @internal
 */
export function hasResponseHeader(parts: ResponseParts, lowerName: string): boolean {
  if (lowerName === CONTENT_TYPE) return responseContentType(parts) !== undefined
  return parts.reply?.headers?.has(lowerName) === true || parts.setHeaders?.has(lowerName) === true
}

/**
 * Returns `true` when the current reply has headers or your code set a header, which means that
 * {@link forEachResponseHeader} can have lines to pass on.
 *
 * @param parts - The package passes the state of the request.
 * @returns The function returns `false` when that function has no line to pass on.
 * @internal
 */
export function hasResponseHeaders(parts: ResponseParts): boolean {
  return parts.reply?.headers !== undefined || parts.setHeaders !== undefined
}

function replaces(set: SetHeader | undefined, replySetAt: number): boolean {
  return set !== undefined && set.setAt > replySetAt && !set.appends
}

/**
 * Returns the lines of one response header that the package sends with the current reply, by the
 * rules of {@link forEachResponseHeader}.
 *
 * @param parts - The package passes the state of the request.
 * @param lowerName - The caller passes the lowercase name of the header.
 * @returns The function returns the lines, or `undefined` when the package sends no line of the header.
 * @internal
 */
export function responseHeaderLines(parts: ResponseParts, lowerName: string): readonly string[] | undefined {
  if (lowerName === CONTENT_TYPE) {
    const contentType = responseContentType(parts)
    return contentType === undefined ? undefined : [contentType]
  }
  const { replySetAt } = parts
  const replyLines = parts.reply?.headers?.get(lowerName)
  const set = parts.setHeaders?.get(lowerName)
  const lines: string[] = []
  if (replyLines !== undefined && !replaces(set, replySetAt)) lines.push(...replyLines)
  if (set !== undefined && !(replyLines !== undefined && set.setAt < replySetAt)) lines.push(...set.lines)
  return lines.length === 0 ? undefined : lines
}

/**
 * Calls a function for each line of every response header that the package sends with the current
 * reply, apart from `content-type`. For a header that both the reply and your code set, the package
 * sends the one that your code or the reply set later, and it sends an appended line after the lines
 * of the reply.
 *
 * @param parts - The package passes the state of the request.
 * @param emit - The package calls this function for each line.
 * @internal
 */
export function forEachResponseHeader(parts: ResponseParts, emit: HeaderVisitor): void {
  const { replySetAt, setHeaders } = parts
  const replyHeaders = parts.reply?.headers
  if (replyHeaders !== undefined) {
    for (const [name, lines] of replyHeaders) {
      if (replaces(setHeaders?.get(name), replySetAt)) continue
      for (const line of lines) emit(name, line, undefined)
    }
  }
  if (setHeaders === undefined) return
  for (const [name, set] of setHeaders) {
    if (name === CONTENT_TYPE) continue
    if (replyHeaders?.has(name) === true && set.setAt < replySetAt) continue
    const { lines, encodings } = set
    for (let index = 0; index < lines.length; index++) emit(name, lines[index] ?? '', encodings[index])
  }
}
