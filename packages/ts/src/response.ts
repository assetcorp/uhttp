import { settableHeaderName } from './headers.js'
import type { Reply } from './reply.js'

const CONTENT_TYPE = 'content-type'

/**
 * The package passes a fixed header to uWebSockets.js as these bytes, which a middleware builds
 * once with `headerBytes`, because uWebSockets.js reads an `ArrayBuffer` in place.
 *
 * @internal
 */
export interface EncodedHeader {
  /** These bytes hold the lowercase name of the header. */
  readonly name: ArrayBuffer
  /**
   * These bytes hold the value of the header, or this is `undefined` for a value that a middleware
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
  /** The middleware checked this lowercase name, which frames no response. */
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
  /** The middleware checked this value, which the encoded bytes hold as well. */
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

interface ContextHeader {
  readonly lines: string[]
  readonly encodings: (EncodedHeader | undefined)[]
  readonly appends: boolean
  setAt: number
}

/**
 * The package keeps the reply of one request and the response headers that code set through the
 * context in this object, and it merges the two when it writes the response.
 *
 * @internal
 */
export class ResponseState {
  #reply: Reply | undefined
  #final = false
  #replySetAt = 0
  #headers: Map<string, ContextHeader> | undefined
  #clock = 0

  /** The chain has produced this reply so far, and it is `undefined` before any reply exists. */
  get reply(): Reply | undefined {
    return this.#reply
  }

  /**
   * Makes a reply the current reply of the request. The headers of a reply that this one replaces
   * no longer go out, while the headers that your code set through the context stay.
   *
   * @param reply - The package makes this reply the current one.
   */
  assign(reply: Reply): void {
    if (this.#final || reply === this.#reply) return
    this.#reply = reply
    this.#replySetAt = ++this.#clock
  }

  /**
   * Makes a reply the current reply of the request for good, so that a later reply of the chain
   * never replaces it.
   *
   * @param reply - The package makes this reply the last one.
   */
  finalize(reply: Reply): void {
    this.assign(reply)
    this.#final = true
  }

  /**
   * Puts a changed form of the current reply in its place, such as a compressed form, while the
   * headers that your code set through the context keep their order against the reply.
   *
   * @param reply - The package passes the changed form of the current reply.
   */
  substitute(reply: Reply): void {
    if (this.#final || this.#reply === undefined) return
    this.#reply = reply
  }

  /**
   * Sets a response header after checking its name and its value. The header goes out with
   * whatever reply the request ends with, unless that reply arrived later with a header of the
   * same name.
   *
   * @param name - The package stores this header name in lowercase.
   * @param value - The package sends this value.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  setHeader(name: string, value: string, append: boolean): void {
    const lowerName = settableHeaderName(name, value)
    if (lowerName !== undefined) this.#store(lowerName, value, undefined, append)
  }

  /**
   * Sets a response header that a middleware checked and encoded once at startup. The method
   * checks it no further.
   *
   * @param header - The middleware passes the prepared header.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  setFixed(header: PreparedHeader, append: boolean): void {
    this.#store(header.name, header.value, header.encoded, append)
  }

  /**
   * Sets a response header under a name that a middleware prepared at startup, with a value that
   * the middleware built and checked for this request. The method checks neither of them again.
   *
   * @param name - The middleware passes the prepared name.
   * @param value - The middleware passes the checked value.
   * @param append - When this is `true`, the package keeps the earlier lines of the header.
   */
  setPrepared(name: PreparedName, value: string, append: boolean): void {
    this.#store(name.name, value, name.encoded, append)
  }

  /**
   * Returns `true` when at least one line of a header goes out with the current reply, whether the
   * reply or your code set it.
   *
   * @param lowerName - The caller passes the lowercase name of the header.
   * @returns The method returns `false` when neither the reply nor your code set the header.
   */
  has(lowerName: string): boolean {
    if (lowerName === CONTENT_TYPE) return this.contentType() !== undefined
    return this.#reply?.headers?.has(lowerName) === true || this.#headers?.has(lowerName) === true
  }

  #store(lowerName: string, value: string, encoded: EncodedHeader | undefined, append: boolean): void {
    this.#headers ??= new Map()
    const setAt = ++this.#clock
    const existing = this.#headers.get(lowerName)
    if (append && existing !== undefined) {
      existing.lines.push(value)
      existing.encodings.push(encoded)
      existing.setAt = setAt
      return
    }
    this.#headers.set(lowerName, { lines: [value], encodings: [encoded], appends: append, setAt })
  }

  /**
   * Returns the content type that the package sends with the current reply. A `content-type`
   * header that your code set after the reply arrived replaces the content type of the reply.
   *
   * @returns The method returns the content type, or `undefined` when neither the reply nor your
   * code set one.
   */
  contentType(): string | undefined {
    const set = this.#headers?.get(CONTENT_TYPE)
    const replyType = this.#reply?.contentType
    if (set !== undefined && (replyType === undefined || set.setAt > this.#replySetAt)) return set.lines.at(-1)
    return replyType
  }

  /**
   * Returns `true` when the current reply carries headers or your code set a header, so that
   * {@link ResponseState.forEachHeader} can have lines to pass on.
   *
   * @returns The method returns `false` when that method has no line to pass on.
   */
  hasHeaders(): boolean {
    return this.#reply?.headers !== undefined || this.#headers !== undefined
  }

  /**
   * Returns the lines of one response header that go out with the current reply, by the rules of
   * {@link ResponseState.forEachHeader}.
   *
   * @param lowerName - The caller passes the lowercase name of the header.
   * @returns The method returns the lines, or `undefined` when no line of the header goes out.
   */
  header(lowerName: string): readonly string[] | undefined {
    if (lowerName === CONTENT_TYPE) {
      const contentType = this.contentType()
      return contentType === undefined ? undefined : [contentType]
    }
    const replyLines = this.#reply?.headers?.get(lowerName)
    const set = this.#headers?.get(lowerName)
    const lines: string[] = []
    if (replyLines !== undefined && !this.#replaces(set)) lines.push(...replyLines)
    if (set !== undefined && !(replyLines !== undefined && set.setAt < this.#replySetAt)) lines.push(...set.lines)
    return lines.length === 0 ? undefined : lines
  }

  #replaces(set: ContextHeader | undefined): boolean {
    return set !== undefined && set.setAt > this.#replySetAt && !set.appends
  }

  /**
   * Calls a function for each line of every response header that goes out with the current reply,
   * apart from `content-type`. For a header that both the reply and your code set, the one that
   * your code or the reply set later goes out, and an appended line follows the lines of the reply.
   *
   * @param emit - The package calls this function for each line.
   */
  forEachHeader(emit: HeaderVisitor): void {
    const replyHeaders = this.#reply?.headers
    const setHeaders = this.#headers
    if (replyHeaders !== undefined) {
      for (const [name, lines] of replyHeaders) {
        if (this.#replaces(setHeaders?.get(name))) continue
        for (const line of lines) emit(name, line, undefined)
      }
    }
    if (setHeaders === undefined) return
    for (const [name, set] of setHeaders) {
      if (name === CONTENT_TYPE) continue
      if (replyHeaders?.has(name) === true && set.setAt < this.#replySetAt) continue
      const { lines, encodings } = set
      for (let index = 0; index < lines.length; index++) emit(name, lines[index] ?? '', encodings[index])
    }
  }
}
