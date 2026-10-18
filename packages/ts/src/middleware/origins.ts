import type { Context } from '../context.js'
import { invalidOption } from './options.js'

/**
 * You pass a function of this type to choose the origins that a request may come from.
 *
 * @param origin - The middleware passes the `Origin` header of the request, which it has checked
 * to be a serialised origin such as `https://shop.example`.
 * @param context - The middleware passes the context of the request.
 * @returns The function returns `true` for an origin that you allow.
 */
export type OriginCheck = (origin: string, context: Context) => boolean | Promise<boolean>

/**
 * A middleware matches the `Origin` header of a request against the origins that you allowed in
 * this form.
 *
 * @internal
 */
export type AllowedOrigins =
  | { readonly kind: 'any' }
  | { readonly kind: 'single'; readonly origin: string }
  | { readonly kind: 'list'; readonly origins: ReadonlySet<string> }
  | { readonly kind: 'check'; readonly check: OriginCheck }

const ANY_ORIGIN = '*'
const OPAQUE_ORIGIN = 'null'

/**
 * Returns `true` when a text is a serialised origin, as a browser sends it in `Origin`, such as
 * `https://shop.example` or `http://localhost:8080`.
 *
 * @param text - The middleware passes the text to check.
 * @returns The function returns `false` for a path, a query, a trailing slash, a default port, or
 * uppercase letters in the host.
 * @internal
 */
export function isSerialisedOrigin(text: string): boolean {
  if (!URL.canParse(text)) return false
  const url = new URL(text)
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === text
}

function checkedOrigin(entry: unknown, name: string, allowOpaque: boolean): string {
  if (typeof entry === 'string' && (isSerialisedOrigin(entry) || (allowOpaque && entry === OPAQUE_ORIGIN))) {
    return entry
  }
  throw invalidOption(
    `Write each origin in ${name} as a browser sends it, such as 'https://shop.example' with no path or trailing slash, and your code passed ${String(entry)}.`,
  )
}

/**
 * Returns the origins that you allowed, after checking each one.
 *
 * @param value - The middleware passes the option: one origin, a list of origins, or an
 * {@link OriginCheck}.
 * @param name - The middleware passes the name of the option for the message of the error, such as
 * `the origin option of cors()`.
 * @param allowAny - The middleware passes `true` when `*` may allow every origin.
 * @param allowOpaque - The middleware passes `true` when you can name the opaque origin as `null`.
 * @returns The function returns the allowed origins.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` for any other value.
 * @internal
 */
export function allowedOrigins(value: unknown, name: string, allowAny: boolean, allowOpaque: boolean): AllowedOrigins {
  if (typeof value === 'function') {
    return { kind: 'check', check: (origin, context) => Reflect.apply(value, undefined, [origin, context]) }
  }
  if (allowAny && value === ANY_ORIGIN) return { kind: 'any' }
  if (typeof value === 'string') return { kind: 'single', origin: checkedOrigin(value, name, allowOpaque) }
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidOption(`Set ${name} to an origin, a list of origins, or a function.`)
  }
  return { kind: 'list', origins: new Set(value.map(entry => checkedOrigin(entry, name, allowOpaque))) }
}

/**
 * Returns `true` when the allowed origins include an origin.
 *
 * @param allowed - The middleware passes the allowed origins.
 * @param origin - The middleware passes the `Origin` header of the request.
 * @param context - The middleware passes the context of the request.
 * @returns The function returns `true`, `false`, or a promise of either.
 * @internal
 */
export function allowsOrigin(allowed: AllowedOrigins, origin: string, context: Context): boolean | Promise<boolean> {
  switch (allowed.kind) {
    case 'any':
      return true
    case 'single':
      return allowed.origin === origin
    case 'list':
      return allowed.origins.has(origin)
    case 'check':
      return isSerialisedOrigin(origin) && allowed.check(origin, context)
  }
}

/**
 * Returns `true` when the allowed origins include the opaque origin `null`.
 *
 * @param allowed - The middleware passes the allowed origins.
 * @returns The function returns `false` for `*`, a function, and every list without `null`.
 * @internal
 */
export function includesOpaqueOrigin(allowed: AllowedOrigins): boolean {
  if (allowed.kind === 'single') return allowed.origin === OPAQUE_ORIGIN
  return allowed.kind === 'list' && allowed.origins.has(OPAQUE_ORIGIN)
}
