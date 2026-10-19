import { randomBytes } from 'node:crypto'
import { type Context, exchangeOf } from '../../context.js'
import { settableHeaderName } from '../../headers.js'
import { defaultHeadersOf } from '../../response.js'
import type { MiddlewareDefinition } from '../../types.js'
import { protocolOf } from '../client.js'
import { type FixedHeader, fixedHeader, fixedName, invalidOption, optionsObject } from '../options.js'
import {
  API_PRESET_HEADERS,
  CONTENT_SECURITY_POLICY,
  DEFAULT_STRICT_TRANSPORT_SECURITY,
  NONCE_BYTES,
  STRICT_TRANSPORT_SECURITY,
  WEB_PRESET_HEADERS,
} from './constants.js'

/**
 * You pass these options to {@link secureHeaders}.
 */
export interface SecureHeadersOptions {
  /**
   * You choose the starting set of headers. Use the `web` preset, which is the default, for pages
   * that a browser renders. With the `api` preset, the middleware sends the headers that OWASP
   * recommends for a JSON API in its REST Security Cheat Sheet, which include
   * `Cache-Control: no-store` and a policy that blocks framing.
   */
  readonly preset?: 'web' | 'api'
  /**
   * You change a header of the preset when you set it to a new value here, switch it off with
   * `false`, and add a header that is missing from the preset when you set it to a value. The package
   * matches the names without regard to case.
   */
  readonly headers?: Readonly<Record<string, string | false>>
  /**
   * When you pass this function, the middleware generates a new nonce for each request, calls the
   * function with it, and sends the policy that the function returns as `Content-Security-Policy`.
   * Read the nonce with {@link nonceOf} to put it on your inline scripts.
   *
   * @param nonce - The middleware passes 16 random bytes in base64.
   * @returns The function returns the policy.
   */
  readonly contentSecurityPolicy?: (nonce: string) => string
}

interface CheckedOptions {
  readonly fixed: readonly FixedHeader[]
  readonly strictTransport: FixedHeader | undefined
  readonly policy: ((nonce: string) => string) | undefined
}

const nonces = new WeakMap<Context, string>()

function presetHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined || value === 'web') return WEB_PRESET_HEADERS
  if (value === 'api') return API_PRESET_HEADERS
  throw invalidOption("Set the preset option of secureHeaders() to 'web' or 'api'.")
}

function headerChanges(value: unknown): Map<string, string | false> {
  const changes = new Map<string, string | false>()
  if (value === undefined) return changes
  for (const [name, setting] of Object.entries(optionsObject(value, 'the headers option of secureHeaders()'))) {
    if (setting !== false && typeof setting !== 'string') {
      throw invalidOption(`Set the '${name}' header in secureHeaders() to a string, or to false to switch it off.`)
    }
    changes.set(name.toLowerCase(), setting)
  }
  return changes
}

function checkedOptions(options: object): CheckedOptions {
  const merged = new Map<string, string | false>(Object.entries(presetHeaders(Reflect.get(options, 'preset'))))
  merged.set(STRICT_TRANSPORT_SECURITY, DEFAULT_STRICT_TRANSPORT_SECURITY)
  const changes = headerChanges(Reflect.get(options, 'headers'))
  for (const [name, setting] of changes) merged.set(name, setting)
  const policy: unknown = Reflect.get(options, 'contentSecurityPolicy')
  if (policy !== undefined && typeof policy !== 'function') {
    throw invalidOption('Set the contentSecurityPolicy option of secureHeaders() to a function that takes the nonce.')
  }
  if (policy !== undefined && typeof changes.get(CONTENT_SECURITY_POLICY) === 'string') {
    throw invalidOption(
      'Pass the policy of secureHeaders() either as the contentSecurityPolicy function or as a fixed header, because the function replaces the fixed one.',
    )
  }
  const fixed: FixedHeader[] = []
  let strictTransport: FixedHeader | undefined
  for (const [name, setting] of merged) {
    if (setting === false || (policy !== undefined && name === CONTENT_SECURITY_POLICY)) continue
    const header = fixedHeader(name, setting)
    if (header.name === STRICT_TRANSPORT_SECURITY) strictTransport = header
    else fixed.push(header)
  }
  return {
    fixed,
    strictTransport,
    policy: policy === undefined ? undefined : nonce => String(Reflect.apply(policy, undefined, [nonce])),
  }
}

/**
 * Returns the nonce that `secureHeaders()` generated for a request, so that you can put it on the
 * inline scripts and styles that your policy allows.
 *
 * @param context - You pass the context of the request.
 * @returns The function returns the nonce in base64, or `undefined` when you put no
 * `secureHeaders()` with a `contentSecurityPolicy` function in front of the route.
 */
export function nonceOf(context: Context): string | undefined {
  return nonces.get(context)
}

/**
 * Returns a middleware that adds security headers to every response. The `web` preset sends
 * `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`,
 * `Origin-Agent-Cluster: ?1`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
 * `X-DNS-Prefetch-Control: off`, `X-Download-Options: noopen`, `X-Frame-Options: SAMEORIGIN`,
 * `X-Permitted-Cross-Domain-Policies: none`, and `X-XSS-Protection: 0`. The `api` preset sends
 * `Cache-Control: no-store`, `Content-Security-Policy: frame-ancestors 'none'`,
 * `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`.
 *
 * With either preset, the middleware also sends
 * `Strict-Transport-Security: max-age=15552000; includeSubDomains`, but only on a TLS connection
 * or when a proxy that `trustedProxies()` trusts reports `https`, because a browser ignores the
 * header over plain HTTP. Add `trustedProxies()` before this middleware, so that the middleware
 * reads the protocol that your proxy reports.
 *
 * The middleware sends each header with every reply of the request, including an error reply and
 * the 503 of a handler that passes its time limit, unless the reply, your code, or an inner
 * `secureHeaders()` sets a header of the same name. It checks and encodes every fixed header once,
 * when you call this function. Because it does its work in a `before` function that returns no
 * promise, the package never has to wait on a request for this middleware. On a 200 with a text or
 * a JSON body, the package writes the fixed headers of the outermost `secureHeaders()` in the same
 * call into uWebSockets.js as the status line, unless another header of the same name replaces one
 * of them.
 *
 * @param options - You can choose the preset, change any header, and ask for a policy with a nonce.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` for an unknown preset, a
 * header name that is not an HTTP token, a value with a control character, a framing header, a
 * policy that is not a function, or a policy function next to a fixed policy.
 */
export function secureHeaders(options?: SecureHeadersOptions): MiddlewareDefinition {
  const { fixed, strictTransport, policy } = checkedOptions(optionsObject(options, 'secureHeaders()'))
  const policyName = fixedName(CONTENT_SECURITY_POLICY)
  const overPlainHttp = fixed.length === 0 ? undefined : defaultHeadersOf(fixed, true)
  const overHttps = strictTransport === undefined ? overPlainHttp : defaultHeadersOf([...fixed, strictTransport], true)
  return {
    before(context) {
      const exchange = exchangeOf(context)
      const block = overHttps !== overPlainHttp && protocolOf(context) === 'https' ? overHttps : overPlainHttp
      if (block !== undefined) exchange.addDefaultHeaders(block)
      if (policy === undefined) return
      const header = { name: policyName.name, value: policyFor(context, policy), encoded: policyName.encoded }
      exchange.addDefaultHeaders(defaultHeadersOf([header], false))
    },
  }
}

function policyFor(context: Context, policy: (nonce: string) => string): string {
  const nonce = randomBytes(NONCE_BYTES).toString('base64')
  nonces.set(context, nonce)
  const value = policy(nonce)
  settableHeaderName(CONTENT_SECURITY_POLICY, value)
  return value
}
