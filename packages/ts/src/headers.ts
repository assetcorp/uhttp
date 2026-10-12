import { COOKIE_HEADER_SEPARATOR, FRAMING_HEADER_NAMES, LIST_HEADER_SEPARATOR } from './constants.js'
import { UhttpError } from './errors.js'

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const DECIMAL_DIGITS = /^\d+$/
const SPACE_CODE = 0x20
const TAB_CODE = 0x09
const DELETE_CODE = 0x7f

/**
 * Returns the UTF-8 bytes of a header name or value in an `ArrayBuffer` of their own. The package
 * builds each one once, because uWebSockets.js reads an `ArrayBuffer` in place, while it converts
 * text to UTF-8 on every call and looks up the underlying buffer of a view such as a `Buffer`.
 *
 * @param text - The package passes a header name or a header value.
 * @returns The function returns a new `ArrayBuffer` that holds the bytes alone.
 * @internal
 */
export function headerBytes(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  const owned = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(owned).set(bytes)
  return owned
}

/**
 * Returns `true` when a text is an HTTP token under RFC 9110, which is the form that every header
 * name must take.
 *
 * @param text - The function checks every character of this text.
 * @returns The function returns `false` for an empty text and for any character outside the
 * token alphabet.
 * @internal
 */
export function isToken(text: string): boolean {
  return TOKEN.test(text)
}

/**
 * Returns `true` when a text is one or more decimal digits, which is the form that a
 * `content-length` value must take.
 *
 * @param text - The function checks every character of this text.
 * @returns The function returns `false` for an empty text and for any character other than a digit.
 * @internal
 */
export function isDecimalDigits(text: string): boolean {
  return DECIMAL_DIGITS.test(text)
}

/**
 * Returns `true` when a text contains a control character other than a tab. The function counts
 * DEL as a control character unless you allow it.
 *
 * @param text - The function checks every character of this text.
 * @param allowDelete - When this is `true`, the function lets DEL through.
 * @returns The function returns `true` for a line break, for NUL, and for any other control
 * character.
 * @internal
 */
export function containsControlCharacter(text: string, allowDelete: boolean): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if ((code < SPACE_CODE && code !== TAB_CODE) || (code === DELETE_CODE && !allowDelete)) return true
  }
  return false
}

/**
 * Returns `true` when a text contains a space or a control character.
 *
 * @param text - The function checks every character of this text.
 * @returns The function returns `true` for any character at or below the space.
 * @internal
 */
export function containsSpaceOrControl(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) <= SPACE_CODE) return true
  }
  return false
}

/**
 * Returns the separator that the package puts between the lines of a request header that a
 * client sent more than once.
 *
 * @param lowerName - The lowercase name of the header.
 * @returns The function returns `; ` for `cookie` and `, ` for any other header.
 * @internal
 */
export function lineSeparatorOf(lowerName: string): string {
  return lowerName === 'cookie' ? COOKIE_HEADER_SEPARATOR : LIST_HEADER_SEPARATOR
}

/**
 * You pass response headers to a reply helper in this shape. For a header such as `set-cookie`
 * that needs more than one line, you pass an array.
 */
export type HeaderRecord = Readonly<Record<string, string | readonly string[]>>

/**
 * The package keeps the lines of each response header under its lowercase name.
 *
 * @internal
 */
export type HeaderLines = Map<string, string[]>

function checkedHeaderName(name: string): string {
  if (!isToken(name)) {
    throw new UhttpError('INVALID_HEADER', `The header name '${name}' must be an HTTP token.`)
  }
  return name.toLowerCase()
}

/**
 * Returns a response header value after checking that it contains no line break, no NUL, and no
 * other control character apart from a tab.
 *
 * @param name - The function puts this header name in the message of the error that it throws.
 * @param value - The function checks this value.
 * @returns The function returns the value unchanged.
 * @throws {@link UhttpError} with the code `INVALID_HEADER` when the value contains a control
 * character.
 * @internal
 */
export function checkedHeaderValue(name: string, value: string): string {
  if (containsControlCharacter(value, false)) {
    throw new UhttpError('INVALID_HEADER', `The value of the '${name}' header must contain no control character.`)
  }
  return value
}

/**
 * Returns the lowercase name of a response header after checking its name and its value, or
 * `undefined` for a header that frames the response, which the package alone sets.
 *
 * @param name - The function checks this name.
 * @param value - The function checks this value.
 * @returns The function returns the name in lowercase, or `undefined` for `content-length`,
 * `transfer-encoding`, `connection`, and `date`.
 * @throws {@link UhttpError} with the code `INVALID_HEADER` when the name or the value fails its
 * check.
 * @internal
 */
export function settableHeaderName(name: string, value: string): string | undefined {
  const lowerName = checkedHeaderName(name)
  checkedHeaderValue(lowerName, value)
  return FRAMING_HEADER_NAMES.includes(lowerName) ? undefined : lowerName
}

/**
 * Adds one checked header to a set of header lines. The function replaces the earlier lines of
 * that header unless `append` is `true`, and it leaves out a header that frames the response.
 *
 * @param lines - The function adds the header to these lines.
 * @param name - The function checks this name and stores it in lowercase.
 * @param value - The function checks this value.
 * @param append - When this is `true`, the function keeps the earlier lines of the header.
 * @throws {@link UhttpError} with the code `INVALID_HEADER` when the name or the value fails its
 * check.
 * @internal
 */
export function putHeader(lines: HeaderLines, name: string, value: string, append: boolean): void {
  const lowerName = settableHeaderName(name, value)
  if (lowerName === undefined) return
  const existing = lines.get(lowerName)
  if (append && existing !== undefined) {
    existing.push(value)
    return
  }
  lines.set(lowerName, [value])
}

/**
 * Returns the checked lines of a header record, with each name in lowercase and without the
 * headers that frame the response.
 *
 * @param record - The function checks every header in this record.
 * @returns The function returns the header lines, or `undefined` when the record is empty.
 * @throws {@link UhttpError} with the code `INVALID_HEADER` when a name or a value fails its
 * check.
 * @internal
 */
export function headerLinesOf(record: HeaderRecord | undefined): HeaderLines | undefined {
  if (record === undefined) return undefined
  let lines: HeaderLines | undefined
  for (const name in record) {
    const value = record[name]
    if (value === undefined) continue
    lines ??= new Map()
    if (typeof value === 'string') {
      putHeader(lines, name, value, true)
      continue
    }
    for (const line of value) putHeader(lines, name, line, true)
  }
  return lines
}
