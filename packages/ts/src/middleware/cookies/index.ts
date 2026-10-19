import type { KeyObject } from 'node:crypto'
import { type Context, exchangeOf } from '../../context.js'
import { UhttpError } from '../../errors.js'
import type { PreparedName } from '../../response.js'
import type { MiddlewareDefinition } from '../../types.js'
import { fixedName, optionsObject } from '../options.js'
import { COOKIE_HEADER, SET_COOKIE_HEADER } from './constants.js'
import { type CookieOptions, setCookieLine } from './serialise.js'
import { signedValue, signingKeys, verifiedValue } from './signing.js'

export type { CookieOptions } from './serialise.js'

/**
 * You pass these options to {@link cookies}.
 */
export interface CookiesOptions {
  /**
   * You pass the keys with which the package signs and verifies cookies, each a string or bytes of
   * at least 20 bytes. The package signs every new cookie with the first key and verifies
   * signatures with every key, so that you can add a new key at the front and drop the oldest one
   * later.
   */
  readonly keys?: readonly (string | Uint8Array)[]
}

interface CookieJar {
  readonly keys: readonly KeyObject[] | undefined
  parsed: Map<string, string> | undefined
}

const jars = new WeakMap<Context, CookieJar>()
let setCookieName: PreparedName | undefined

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

function parseCookies(header: string | undefined): Map<string, string> {
  const parsed = new Map<string, string>()
  if (header === undefined) return parsed
  let start = 0
  while (start <= header.length) {
    let end = header.indexOf(';', start)
    if (end === -1) end = header.length
    const equals = header.indexOf('=', start)
    if (equals !== -1 && equals < end) {
      const name = header.slice(start, equals).trim()
      if (name !== '' && !parsed.has(name)) parsed.set(name, stripQuotes(header.slice(equals + 1, end).trim()))
    }
    start = end + 1
  }
  return parsed
}

function cookiesOf(context: Context): Map<string, string> {
  const jar = jars.get(context)
  if (jar === undefined) return parseCookies(context.req.header(COOKIE_HEADER))
  jar.parsed ??= parseCookies(context.req.header(COOKIE_HEADER))
  return jar.parsed
}

function keysOf(context: Context): readonly KeyObject[] {
  const keys = jars.get(context)?.keys
  if (keys === undefined) {
    throw new UhttpError('INVALID_COOKIE', 'Pass keys to cookies() on this route before you sign or verify a cookie.')
  }
  return keys
}

function appendLine(context: Context, line: string): void {
  setCookieName ??= fixedName(SET_COOKIE_HEADER)
  exchangeOf(context).setPrepared(setCookieName, line, true)
}

/**
 * Returns a middleware that declares the `Cookie` header and stores the signing keys for the cookie
 * helpers on each request. The helpers parse the header the first time that you read a cookie,
 * across every `Cookie` line that the client sent.
 *
 * @param options - You can pass the keys with which the package signs and verifies cookies.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when `keys` is an empty
 * list, or when a key is neither a string nor bytes or is shorter than 20 bytes.
 */
export function cookies(options?: CookiesOptions): MiddlewareDefinition {
  const keys = signingKeys(Reflect.get(optionsObject(options, 'cookies()'), 'keys'))
  return {
    headers: [COOKIE_HEADER],
    before(context) {
      jars.set(context, { keys, parsed: undefined })
    },
  }
}

/**
 * Returns the value of a cookie that the client sent. When the client sent the name twice, the
 * function returns the first value, which the browser sends for the most specific path.
 *
 * @param context - You pass the context of a request on a route behind `cookies()`.
 * @param name - You pass the name of the cookie.
 * @returns The function returns the value without surrounding quotes, or `undefined` when the
 * client sent no such cookie.
 * @throws {@link UhttpError} with the code `UNDECLARED_HEADER` when neither `cookies()` nor the
 * route declared the `cookie` header.
 */
export function getCookie(context: Context, name: string): string | undefined {
  return cookiesOf(context).get(name)
}

/**
 * Returns the value of a signed cookie when the function can verify its signature with one of the
 * keys of `cookies()`. The function compares the signatures in constant time.
 *
 * @param context - You pass the context of a request on a route behind `cookies()` with `keys`.
 * @param name - You pass the name of the cookie.
 * @returns The function returns the value without its signature, or `undefined` when the client
 * sent no such cookie or a signature that the function can verify with none of the keys.
 * @throws {@link UhttpError} with the code `INVALID_COOKIE` when you put no `cookies()` with `keys`
 * in front of the route.
 */
export function getSignedCookie(context: Context, name: string): string | undefined {
  const keys = keysOf(context)
  const signed = cookiesOf(context).get(name)
  return signed === undefined ? undefined : verifiedValue(keys, name, signed)
}

/**
 * Sets a cookie on the response, with `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/` unless
 * you change them. The function sends the value as you pass it, so encode it yourself when it can
 * contain characters outside the cookie alphabet.
 *
 * @param context - You pass the context of the request.
 * @param name - You pass the name, which must be an HTTP token.
 * @param value - You pass the value.
 * @param options - You can change the attributes of the cookie.
 * @throws {@link UhttpError} with the code `INVALID_COOKIE` for a name that is not a token, a value
 * or an attribute with `;` or a control character, a name and a value above 4,096 bytes,
 * `SameSite=None` or `Partitioned` without `Secure`, a `Max-Age` that is not a whole number up to
 * 400 days, or a `__Secure-` or `__Host-` name, in any case, whose attributes differ from what
 * browsers require for its prefix.
 */
export function setCookie(context: Context, name: string, value: string, options: CookieOptions = {}): void {
  appendLine(context, setCookieLine(name, value, options, false))
}

/**
 * Sets a cookie with an HMAC-SHA-256 signature after its value, which the function makes with the
 * first key of `cookies()`, so that {@link getSignedCookie} returns `undefined` once the client
 * changes the value. The function signs the name together with the value, so that
 * {@link getSignedCookie} returns the value only under the name that the function signed.
 *
 * @param context - You pass the context of a request on a route behind `cookies()` with `keys`.
 * @param name - You pass the name, which must be an HTTP token.
 * @param value - You pass the value.
 * @param options - You can change the attributes of the cookie.
 * @throws {@link UhttpError} with the code `INVALID_COOKIE` in the cases of {@link setCookie}, and
 * when you put no `cookies()` with `keys` in front of the route.
 */
export function setSignedCookie(context: Context, name: string, value: string, options: CookieOptions = {}): void {
  appendLine(context, setCookieLine(name, signedValue(keysOf(context), name, value), options, false))
}

/**
 * Deletes a cookie in the browser by setting it again with an empty value, `Max-Age=0`, and an
 * expiry in 1970. Pass the same `path` and `domain` that you used to set the cookie, because the
 * browser keeps a cookie whose path or domain differs.
 *
 * @param context - You pass the context of the request.
 * @param name - You pass the name of the cookie.
 * @param options - You pass the attributes that you used to set the cookie.
 * @throws {@link UhttpError} with the code `INVALID_COOKIE` in the cases of {@link setCookie}.
 */
export function deleteCookie(context: Context, name: string, options: CookieOptions = {}): void {
  appendLine(context, setCookieLine(name, '', options, true))
}
