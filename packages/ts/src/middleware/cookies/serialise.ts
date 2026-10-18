import { UhttpError } from '../../errors.js'
import { isToken } from '../../headers.js'
import { EPOCH_EXPIRY, HOST_PREFIX, MAX_COOKIE_BYTES, MAX_COOKIE_MAX_AGE_SECONDS, SECURE_PREFIX } from './constants.js'

/**
 * You pass these attributes when you set or delete a cookie. The package sets `HttpOnly`, `Secure`,
 * `SameSite=Lax`, and `Path=/` on a new cookie unless you change them.
 */
export interface CookieOptions {
  /** The browser sends the cookie to this domain and its subdomains, and only to the host that set it when you leave it out. */
  readonly domain?: string
  /** The browser sends the cookie to paths under this one, which is `/` by default. */
  readonly path?: string
  /** The browser keeps the cookie for this many whole seconds, up to 400 days. */
  readonly maxAge?: number
  /** The browser keeps the cookie until this date. */
  readonly expires?: Date
  /** When this is `true`, which is the default, the browser hides the cookie from the scripts of the page. */
  readonly httpOnly?: boolean
  /**
   * When this is `true`, which is the default, the browser sends the cookie only over HTTPS.
   * Safari drops a `Secure` cookie from `http://localhost`, so switch it off there in development.
   */
  readonly secure?: boolean
  /**
   * The browser sends the cookie with requests from other sites according to this rule, which is
   * `Lax` by default. A browser stores a cookie with `None` only when the cookie also has `Secure`.
   */
  readonly sameSite?: 'Strict' | 'Lax' | 'None'
  /** When this is `true`, the browser keeps a separate copy of the cookie for each top-level site, as long as the cookie also has `Secure`. */
  readonly partitioned?: boolean
}

const UNSAFE_ATTRIBUTE = /[\p{Cc};]/u

function invalidCookie(message: string): UhttpError {
  return new UhttpError('INVALID_COOKIE', message)
}

function checkedAttribute(value: string, name: string): string {
  if (UNSAFE_ATTRIBUTE.test(value)) {
    throw invalidCookie(`Leave ';' and control characters out of the ${name} of a cookie.`)
  }
  return value
}

function checkedMaxAge(value: number): number {
  if (!Number.isSafeInteger(value) || value > MAX_COOKIE_MAX_AGE_SECONDS) {
    throw invalidCookie(`Set the maxAge of a cookie to a whole number of seconds up to ${MAX_COOKIE_MAX_AGE_SECONDS}.`)
  }
  return value
}

function checkedExpiry(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw invalidCookie('Set the expires of a cookie to a valid date.')
  }
  return value.toUTCString()
}

function checkPrefix(name: string, secure: boolean, path: string, domain: string | undefined): void {
  const lowerName = name.toLowerCase()
  if (lowerName.startsWith(SECURE_PREFIX) && !secure) {
    throw invalidCookie(
      `Keep Secure on for the cookie '${name}', because browsers reject a __Secure- cookie without it.`,
    )
  }
  if (lowerName.startsWith(HOST_PREFIX) && (!secure || path !== '/' || domain !== undefined)) {
    throw invalidCookie(
      `Keep Secure on, keep the path at '/', and leave out the domain for the cookie '${name}', because browsers reject a __Host- cookie otherwise.`,
    )
  }
}

/**
 * Returns the `Set-Cookie` line of a cookie after checking its name, its value, and its attributes.
 *
 * @param name - The caller passes the name, which must be an HTTP token.
 * @param value - The caller passes the value, which the function leaves unencoded.
 * @param options - The caller passes the attributes.
 * @param removal - The caller passes `true` to delete the cookie.
 * @returns The function returns the line.
 * @throws {@link UhttpError} with the code `INVALID_COOKIE` for a name that is not a token, a value
 * or an attribute with `;` or a control character, a name and a value above 4,096 bytes, or
 * attributes outside the rules of `SameSite=None`, `Partitioned`, or a name prefix.
 * @internal
 */
export function setCookieLine(name: string, value: string, options: CookieOptions, removal: boolean): string {
  if (!isToken(name)) throw invalidCookie(`Name the cookie with an HTTP token, and '${name}' is not one.`)
  checkedAttribute(value, 'value')
  if (Buffer.byteLength(name) + Buffer.byteLength(value) > MAX_COOKIE_BYTES) {
    throw invalidCookie(`Keep the name and the value of the cookie '${name}' within ${MAX_COOKIE_BYTES} bytes.`)
  }
  const { domain, maxAge, expires, partitioned = false, sameSite = 'Lax' } = options
  const path = options.path ?? '/'
  const secure = options.secure ?? true
  if (sameSite !== 'Strict' && sameSite !== 'Lax' && sameSite !== 'None') {
    throw invalidCookie("Set the sameSite of a cookie to 'Strict', 'Lax', or 'None'.")
  }
  if ((sameSite === 'None' || partitioned) && !secure) {
    throw invalidCookie(
      `Keep Secure on for the cookie '${name}', because browsers reject SameSite=None and Partitioned without it.`,
    )
  }
  checkPrefix(name, secure, path, domain)
  let line = `${name}=${value}`
  if (removal) line += '; Max-Age=0'
  else if (maxAge !== undefined) line += `; Max-Age=${checkedMaxAge(maxAge)}`
  if (domain !== undefined) line += `; Domain=${checkedAttribute(domain, 'domain')}`
  line += `; Path=${checkedAttribute(path, 'path')}`
  if (removal) line += `; Expires=${EPOCH_EXPIRY}`
  else if (expires !== undefined) line += `; Expires=${checkedExpiry(expires)}`
  if (options.httpOnly ?? true) line += '; HttpOnly'
  if (secure) line += '; Secure'
  line += `; SameSite=${sameSite}`
  if (partitioned) line += '; Partitioned'
  return line
}
