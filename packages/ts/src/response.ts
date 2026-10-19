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
 * A middleware attaches a block of response headers in this form to a request, and the package sends
 * each header of the block unless the reply or your code sets a header of the same name. When two
 * blocks have a header of the same name, the package sends the header of the block that a
 * middleware attached later.
 *
 * @internal
 */
export interface DefaultHeaders {
  /** The package sends these headers, each of which a middleware checked and encoded. */
  readonly headers: readonly PreparedHeader[]
  /**
   * For a block that a middleware built once at startup, the package keeps here the bytes of the
   * status line, the content type, and the block, under the content type. For a block that a
   * middleware builds for one request, this is `undefined`.
   */
  readonly heads: Map<string, ArrayBuffer> | undefined
}

/**
 * Returns a block of response headers that a request sends unless the reply or your code sets a
 * header of the same name.
 *
 * @param headers - The middleware passes the checked headers of the block.
 * @param fixed - The middleware passes `true` for a block that it builds once at startup, which the
 * package can then write in the same call as the status line.
 * @returns The function returns the block.
 * @internal
 */
export function defaultHeadersOf(headers: readonly PreparedHeader[], fixed: boolean): DefaultHeaders {
  const foldable = fixed && headers.every(header => header.name !== CONTENT_TYPE)
  return { headers, heads: foldable ? new Map() : undefined }
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
export interface ContextHeader {
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
export type ContextHeaders = Map<string, ContextHeader>

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
  readonly contextHeaders: ContextHeaders | undefined
  /** Middleware attached these blocks of headers in this order, and this is `undefined` until a middleware attaches one. */
  readonly defaultHeaders: readonly DefaultHeaders[] | undefined
}

function setsHeader(parts: ResponseParts, lowerName: string): boolean {
  return parts.reply?.headers?.has(lowerName) === true || parts.contextHeaders?.has(lowerName) === true
}

function laterBlockHas(blocks: readonly DefaultHeaders[], index: number, lowerName: string): boolean {
  for (let later = index + 1; later < blocks.length; later++) {
    if (blocks[later]?.headers.some(header => header.name === lowerName) === true) return true
  }
  return false
}

function defaultHeaderOf(parts: ResponseParts, lowerName: string): PreparedHeader | undefined {
  const blocks = parts.defaultHeaders
  if (blocks === undefined) return undefined
  for (let index = blocks.length - 1; index >= 0; index--) {
    const header = blocks[index]?.headers.find(candidate => candidate.name === lowerName)
    if (header !== undefined) return header
  }
  return undefined
}

/**
 * Returns the first block of default headers when the package can send every header of it, so
 * that the package can write the whole block in the same call as the status line. The function
 * returns `undefined` for a block that a middleware built for one request, and for a block with a
 * header that the reply, your code, or a later block sets.
 *
 * @param parts - The package passes the state of the request.
 * @returns The function returns the block, or `undefined` when the package writes each header on its own.
 * @internal
 */
export function foldableDefaults(parts: ResponseParts): DefaultHeaders | undefined {
  const blocks = parts.defaultHeaders
  const first = blocks?.[0]
  if (blocks === undefined || first?.heads === undefined) return undefined
  if (blocks.length === 1 && parts.reply?.headers === undefined && parts.contextHeaders === undefined) return first
  for (const header of first.headers) {
    if (setsHeader(parts, header.name) || laterBlockHas(blocks, 0, header.name)) return undefined
  }
  return first
}

/**
 * Calls a function for each default header that the package sends with the current reply, from
 * the block at a given place in the list of blocks onwards. The package skips a header that the
 * reply, your code, or a later block sets.
 *
 * @param parts - The package passes the state of the request.
 * @param emit - The package calls this function for each header.
 * @param from - The package passes the place of the first block to visit, which is 1 when it wrote the first block with the status line.
 * @internal
 */
export function forEachDefaultHeader(parts: ResponseParts, emit: HeaderVisitor, from: number): void {
  const blocks = parts.defaultHeaders
  if (blocks === undefined) return
  for (let index = from; index < blocks.length; index++) {
    for (const header of blocks[index]?.headers ?? []) {
      if (header.name === CONTENT_TYPE || setsHeader(parts, header.name)) continue
      if (laterBlockHas(blocks, index, header.name)) continue
      emit(header.name, header.value, header.encoded)
    }
  }
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
  headers: ContextHeaders | undefined,
  lowerName: string,
  value: string,
  encoded: EncodedHeader | undefined,
  append: boolean,
  setAt: number,
): ContextHeaders {
  const stored = headers ?? new Map<string, ContextHeader>()
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
 * of the content type of the reply. When neither of them has a content type, the package sends the
 * one from a block of default headers.
 *
 * @param parts - The package passes the state of the request.
 * @returns The function returns the content type, or `undefined` when neither the reply, your code,
 * nor a block of default headers set one.
 * @internal
 */
export function responseContentType(parts: ResponseParts): string | undefined {
  const set = parts.contextHeaders?.get(CONTENT_TYPE)
  const replyType = parts.reply?.contentType
  if (set !== undefined && (replyType === undefined || set.setAt > parts.replySetAt)) return set.lines.at(-1)
  return replyType ?? defaultHeaderOf(parts, CONTENT_TYPE)?.value
}

/**
 * Returns `true` when the package sends at least one line of a header with the current reply,
 * whether the reply, your code, or a block of default headers set it.
 *
 * @param parts - The package passes the state of the request.
 * @param lowerName - The caller passes the lowercase name of the header.
 * @returns The function returns `false` when the package sends no line of the header.
 * @internal
 */
export function hasResponseHeader(parts: ResponseParts, lowerName: string): boolean {
  if (lowerName === CONTENT_TYPE) return responseContentType(parts) !== undefined
  return setsHeader(parts, lowerName) || defaultHeaderOf(parts, lowerName) !== undefined
}

/**
 * Returns `true` when the current reply has headers or your code set a header, which means that
 * {@link forEachSetHeader} can have lines to pass on.
 *
 * @param parts - The package passes the state of the request.
 * @returns The function returns `false` when that function has no line to pass on.
 * @internal
 */
export function hasSetHeaders(parts: ResponseParts): boolean {
  return parts.reply?.headers !== undefined || parts.contextHeaders !== undefined
}

function replaces(set: ContextHeader | undefined, replySetAt: number): boolean {
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
  const set = parts.contextHeaders?.get(lowerName)
  const lines: string[] = []
  if (replyLines !== undefined && !replaces(set, replySetAt)) lines.push(...replyLines)
  if (set !== undefined && !(replyLines !== undefined && set.setAt < replySetAt)) lines.push(...set.lines)
  if (lines.length > 0) return lines
  const fallback = defaultHeaderOf(parts, lowerName)
  return fallback === undefined ? undefined : [fallback.value]
}

/**
 * Calls a function for each line of every response header that the package sends with the current
 * reply, apart from `content-type`. The function visits the headers of the reply and of your code
 * as {@link forEachSetHeader} does, and then every default header that neither of them sets.
 *
 * @param parts - The package passes the state of the request.
 * @param emit - The package calls this function for each line.
 * @internal
 */
export function forEachResponseHeader(parts: ResponseParts, emit: HeaderVisitor): void {
  forEachSetHeader(parts, emit)
  forEachDefaultHeader(parts, emit, 0)
}

/**
 * Calls a function for each line of every response header that the reply or your code set, apart
 * from `content-type`. For a header that both the reply and your code set, the package sends the
 * one that your code or the reply set later, and it sends an appended line after the lines of the
 * reply.
 *
 * @param parts - The package passes the state of the request.
 * @param emit - The package calls this function for each line.
 * @internal
 */
export function forEachSetHeader(parts: ResponseParts, emit: HeaderVisitor): void {
  const { replySetAt, contextHeaders } = parts
  const replyHeaders = parts.reply?.headers
  if (replyHeaders !== undefined) {
    for (const [name, lines] of replyHeaders) {
      if (replaces(contextHeaders?.get(name), replySetAt)) continue
      for (const line of lines) emit(name, line, undefined)
    }
  }
  if (contextHeaders === undefined) return
  for (const [name, set] of contextHeaders) {
    if (name === CONTENT_TYPE) continue
    if (replyHeaders?.has(name) === true && set.setAt < replySetAt) continue
    const { lines, encodings } = set
    for (let index = 0; index < lines.length; index++) emit(name, lines[index] ?? '', encodings[index])
  }
}
