const TOKEN_CHARACTER = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/
const WHITESPACE = /[ \t]/
const QUOTE = '"'
const BACKSLASH = '\\'
const SEMICOLON = ';'
const EQUALS = '='

/**
 * The package parses a `Content-Type` header into this form.
 *
 * @internal
 */
export interface MediaType {
  /** This is the type and the subtype in lowercase, such as `application/json`. */
  readonly type: string
  /** The header has these parameters, with each name in lowercase, in a store with no prototype. */
  readonly parameters: Readonly<Record<string, string>>
}

interface Cursor {
  readonly text: string
  position: number
}

function skipWhitespace(cursor: Cursor): void {
  while (cursor.position < cursor.text.length && WHITESPACE.test(cursor.text.charAt(cursor.position))) cursor.position++
}

function readToken(cursor: Cursor): string {
  const start = cursor.position
  while (cursor.position < cursor.text.length && TOKEN_CHARACTER.test(cursor.text.charAt(cursor.position))) {
    cursor.position++
  }
  return cursor.text.slice(start, cursor.position)
}

function readQuoted(cursor: Cursor, quotedPairs: boolean): string | undefined {
  cursor.position++
  let value = ''
  while (cursor.position < cursor.text.length) {
    const character = cursor.text.charAt(cursor.position++)
    if (character === QUOTE) return value
    if (quotedPairs && character === BACKSLASH && cursor.position < cursor.text.length) {
      value += cursor.text.charAt(cursor.position++)
      continue
    }
    value += character
  }
  return undefined
}

/**
 * Returns the parameters that follow a value such as a media type or a disposition type, in a
 * store with no prototype. Each parameter takes the form `name=token` or `name="quoted text"`,
 * and the function keeps the first value of a repeated name.
 *
 * @param text - The function reads the parameters of this header value.
 * @param start - The function starts at this position, which is the end of the type.
 * @param quotedPairs - When this is `true`, a backslash in quoted text escapes the next character,
 * as RFC 9110 defines. A browser leaves a backslash in a multipart filename unescaped, so the
 * multipart parser passes `false`.
 * @returns The function returns the parameters, or `undefined` when the text breaks the syntax.
 * @internal
 */
export function parseParameters(text: string, start: number, quotedPairs: boolean): Record<string, string> | undefined {
  const parameters: Record<string, string> = Object.create(null)
  const cursor: Cursor = { text, position: start }
  while (true) {
    skipWhitespace(cursor)
    if (cursor.position >= text.length) return parameters
    if (text.charAt(cursor.position) !== SEMICOLON) return undefined
    cursor.position++
    skipWhitespace(cursor)
    if (cursor.position >= text.length) return parameters
    const name = readToken(cursor).toLowerCase()
    if (name === '' || text.charAt(cursor.position) !== EQUALS) return undefined
    cursor.position++
    const value = text.charAt(cursor.position) === QUOTE ? readQuoted(cursor, quotedPairs) : readToken(cursor)
    if (value === undefined) return undefined
    if (!(name in parameters)) parameters[name] = value
  }
}

/**
 * Returns the media type of a `Content-Type` header under RFC 9110. Every body parser calls this
 * function, so that the parsers agree on every header, and a CSRF middleware can call it too.
 *
 * @param header - The function parses this header value, which is `undefined` when the request has none.
 * @returns The function returns the media type, or `undefined` for a missing or malformed header.
 * @internal
 */
export function parseMediaType(header: string | undefined): MediaType | undefined {
  if (header === undefined) return undefined
  const cursor: Cursor = { text: header, position: 0 }
  skipWhitespace(cursor)
  const type = readToken(cursor)
  if (type === '' || header.charAt(cursor.position) !== '/') return undefined
  cursor.position++
  const subtype = readToken(cursor)
  if (subtype === '') return undefined
  const parameters = parseParameters(header, cursor.position, true)
  if (parameters === undefined) return undefined
  return { type: `${type}/${subtype}`.toLowerCase(), parameters }
}

/**
 * Returns `true` for a JSON media type, which is `application/json` or any `application/*+json`.
 *
 * @param mediaType - The function checks this media type.
 * @returns The function returns `false` for a missing media type and for every other type.
 * @internal
 */
export function isJsonType(mediaType: MediaType | undefined): boolean {
  if (mediaType === undefined) return false
  const { type } = mediaType
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'))
}
