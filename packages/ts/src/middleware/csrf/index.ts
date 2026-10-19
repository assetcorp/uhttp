import { parseMediaType } from '../../body/media-type.js'
import type { Context } from '../../context.js'
import { UhttpError } from '../../errors.js'
import type { MiddlewareDefinition } from '../../types.js'
import { hostOf, protocolOf } from '../client.js'
import { isThenable, optionsObject } from '../options.js'
import { type AllowedOrigins, allowedOrigins, allowsOrigin, type OriginCheck } from '../origins.js'
import {
  ALLOWED_FETCH_SITES,
  CONTENT_TYPE_HEADER,
  FETCH_SITE_HEADER,
  FORM_CONTENT_TYPES,
  HOST_HEADER,
  HTTP_PORT_SUFFIX,
  HTTPS_PORT_SUFFIX,
  ORIGIN_HEADER,
  SAFE_METHODS,
} from './constants.js'

export type { OriginCheck } from '../origins.js'

/**
 * You pass these options to {@link csrf}.
 */
export interface CsrfOptions {
  /**
   * You name the origins that may send a form to your app from another site: one origin, a list of
   * origins, or an {@link OriginCheck} function, which can be async. When you leave this out, the
   * middleware allows only the origin of the request itself, built from the protocol and the host
   * that `trustedProxies()` reports or from the connection and the `Host` header.
   */
  readonly origin?: string | readonly string[] | OriginCheck
}

function ownOrigin(context: Context): string | undefined {
  const protocol = protocolOf(context)
  let host = hostOf(context)
  if (host === undefined) return undefined
  const defaultPort = protocol === 'https' ? HTTPS_PORT_SUFFIX : HTTP_PORT_SUFFIX
  if (host.endsWith(defaultPort)) host = host.slice(0, -defaultPort.length)
  return `${protocol}://${host}`
}

function sendableByForm(contentType: string | undefined): boolean {
  if (contentType === undefined) return true
  const media = parseMediaType(contentType)
  return media === undefined || FORM_CONTENT_TYPES.includes(media.type)
}

function allowedRequest(context: Context, named: AllowedOrigins | undefined): boolean | Promise<boolean> {
  const site = context.req.header(FETCH_SITE_HEADER)
  if (site !== undefined && ALLOWED_FETCH_SITES.includes(site)) return true
  const origin = context.req.header(ORIGIN_HEADER)
  if (origin === undefined) return false
  if (named !== undefined) return allowsOrigin(named, origin, context)
  return site === undefined && origin === ownOrigin(context)
}

/**
 * Returns a middleware that rejects a cross-site form submission, with which an attacker can carry
 * out a cross-site request forgery. The middleware checks every request with a method other than
 * GET, HEAD, OPTIONS, and TRACE whose content type a browser can send from a form without a
 * preflight: `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain`. It
 * treats a request without a content type, or with a malformed one, as `text/plain`.
 *
 * The middleware allows such a request when the browser sends `Sec-Fetch-Site: same-origin` or
 * `none`. When the browser sends `Sec-Fetch-Site` with any other value, the middleware allows the
 * request only from an origin that you named. When the browser sends no `Sec-Fetch-Site`, the
 * middleware compares `Origin` with the allowed origins. It rejects a request that has neither
 * header. The package replies to a rejected request with a 403 and the code `CSRF_REJECTED`, and
 * it never calls the handler for that request.
 *
 * @param options - You can name the origins that may send a form from another site.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when `origin` is `*`,
 * `null`, or not a valid origin, a list of them, or a function.
 */
export function csrf(options?: CsrfOptions): MiddlewareDefinition {
  const value: unknown = Reflect.get(optionsObject(options, 'csrf()'), 'origin')
  const named = value === undefined ? undefined : allowedOrigins(value, 'the origin option of csrf()', false, false)
  return {
    headers: [FETCH_SITE_HEADER, ORIGIN_HEADER, CONTENT_TYPE_HEADER, HOST_HEADER],
    before(context): undefined | Promise<void> {
      if (SAFE_METHODS.includes(context.req.method) || !sendableByForm(context.req.header(CONTENT_TYPE_HEADER))) return
      const allowed: unknown = allowedRequest(context, named)
      if (isThenable(allowed)) {
        return Promise.resolve(allowed).then(verdict => {
          if (!verdict) throw rejection()
        })
      }
      if (!allowed) throw rejection()
      return undefined
    },
  }
}

function rejection(): UhttpError {
  return new UhttpError(
    'CSRF_REJECTED',
    'The package rejected this request, because the app allows neither the value of its Sec-Fetch-Site header nor the value of its Origin header.',
  )
}
