import { type Context, exchangeOf } from '../../context.js'
import { type Exchange, setFixed, setPrepared } from '../../exchange/index.js'
import { isToken } from '../../headers.js'
import { createReply, type Reply } from '../../reply.js'
import type { PreparedName } from '../../response.js'
import type { MiddlewareDefinition } from '../../types.js'
import {
  booleanOption,
  type FixedHeader,
  fixedHeader,
  fixedName,
  invalidOption,
  optionsObject,
  stringListOption,
  wholeNumberOption,
} from '../options.js'
import {
  type AllowedOrigins,
  allowedOrigins,
  allowsOrigin,
  includesOpaqueOrigin,
  type OriginCheck,
} from '../origins.js'
import {
  ALLOW_CREDENTIALS_HEADER,
  ALLOW_HEADERS_HEADER,
  ALLOW_METHODS_HEADER,
  ALLOW_ORIGIN_HEADER,
  DEFAULT_CORS_MAX_AGE_SECONDS,
  DEFAULT_CORS_METHODS,
  ECHOED_REQUEST_HEADERS_LENGTH_LIMIT,
  EXPOSE_HEADERS_HEADER,
  MAX_AGE_HEADER,
  MAX_CORS_MAX_AGE_SECONDS,
  ORIGIN_HEADER,
  PREFLIGHT_STATUS,
  REQUEST_HEADERS_HEADER,
  REQUEST_METHOD_HEADER,
  VARY_HEADER,
} from './constants.js'

export type { OriginCheck } from '../origins.js'

/**
 * You pass these options to {@link cors}.
 */
export interface CorsOptions {
  /**
   * You name the origins whose scripts may read your responses: one origin such as
   * `https://shop.example`, `*` for every origin, a list of origins, or an {@link OriginCheck}
   * function, which can be async. Write each origin as a browser sends it, with no path and no
   * trailing slash.
   */
  readonly origin: string | readonly string[] | OriginCheck
  /** The middleware allows these methods in reply to a preflight request, which are GET, HEAD, PUT, POST, DELETE, and PATCH by default. */
  readonly methods?: readonly string[]
  /**
   * The middleware allows these request headers in reply to a preflight request. When you leave
   * this out, the middleware allows the headers that the browser lists in the preflight request.
   */
  readonly allowHeaders?: readonly string[]
  /** The middleware lets a script read these response headers beyond the ones that every browser exposes. */
  readonly exposeHeaders?: readonly string[]
  /** When this is `true`, a browser sends cookies with a credentialed request and lets the script read the response. */
  readonly credentials?: boolean
  /** A browser caches the result of a preflight request for this many seconds, which is 600 by default. */
  readonly maxAge?: number
}

interface CorsPlan {
  readonly allowed: AllowedOrigins
  readonly staticOrigin: FixedHeader | undefined
  readonly credentials: FixedHeader | undefined
  readonly expose: FixedHeader | undefined
  readonly methods: FixedHeader
  readonly allowHeaders: FixedHeader | undefined
  readonly maxAge: FixedHeader
  readonly varyOrigin: FixedHeader
  readonly varyRequestHeaders: FixedHeader
  readonly allowOriginName: PreparedName
  readonly allowHeadersName: PreparedName
}

function tokenList(value: unknown, name: string): string | undefined {
  const list = stringListOption(value, name)
  if (list === undefined) return undefined
  for (const entry of list) {
    if (!isToken(entry)) throw invalidOption(`Write each entry of ${name} as an HTTP token, and '${entry}' is not one.`)
  }
  return list.join(', ')
}

function listHeader(name: string, list: string | undefined): FixedHeader | undefined {
  return list === undefined || list === '' ? undefined : fixedHeader(name, list)
}

function corsPlan(options: object): CorsPlan {
  const allowed = allowedOrigins(Reflect.get(options, 'origin'), 'the origin option of cors()', true, true)
  const credentials = booleanOption(Reflect.get(options, 'credentials'), 'the credentials option of cors()', false)
  if (credentials && (allowed.kind === 'any' || includesOpaqueOrigin(allowed))) {
    throw invalidOption(
      "Name the origins in the origin option of cors() when credentials is true, because a browser rejects '*' with credentials, while any page can send the origin 'null'.",
    )
  }
  const maxAge: unknown = Reflect.get(options, 'maxAge') ?? DEFAULT_CORS_MAX_AGE_SECONDS
  const methods = tokenList(Reflect.get(options, 'methods'), 'the methods option of cors()')
  return {
    allowed,
    staticOrigin:
      allowed.kind === 'any'
        ? fixedHeader(ALLOW_ORIGIN_HEADER, '*')
        : allowed.kind === 'single'
          ? fixedHeader(ALLOW_ORIGIN_HEADER, allowed.origin)
          : undefined,
    credentials: credentials ? fixedHeader(ALLOW_CREDENTIALS_HEADER, 'true') : undefined,
    expose: listHeader(
      EXPOSE_HEADERS_HEADER,
      tokenList(Reflect.get(options, 'exposeHeaders'), 'the exposeHeaders option of cors()'),
    ),
    methods: fixedHeader(ALLOW_METHODS_HEADER, methods ?? DEFAULT_CORS_METHODS.join(', ')),
    allowHeaders: listHeader(
      ALLOW_HEADERS_HEADER,
      tokenList(Reflect.get(options, 'allowHeaders'), 'the allowHeaders option of cors()'),
    ),
    maxAge: fixedHeader(
      MAX_AGE_HEADER,
      String(wholeNumberOption(maxAge, 'the maxAge option of cors()', 0, MAX_CORS_MAX_AGE_SECONDS)),
    ),
    varyOrigin: fixedHeader(VARY_HEADER, 'Origin'),
    varyRequestHeaders: fixedHeader(VARY_HEADER, 'Access-Control-Request-Headers'),
    allowOriginName: fixedName(ALLOW_ORIGIN_HEADER),
    allowHeadersName: fixedName(ALLOW_HEADERS_HEADER),
  }
}

function echoedRequestHeaders(requested: string | undefined): string | undefined {
  if (requested === undefined || requested.length > ECHOED_REQUEST_HEADERS_LENGTH_LIMIT) return undefined
  const entries = requested.split(',')
  for (let index = 0; index < entries.length; index++) {
    const entry = (entries[index] ?? '').trim()
    if (!isToken(entry)) return undefined
    entries[index] = entry
  }
  return entries.join(', ')
}

/**
 * Returns a middleware that adds CORS headers for the origins that you allow. For a list or a
 * function, the middleware sends `Access-Control-Allow-Origin` to an allowed origin and no CORS
 * header to any other origin, and it adds `Vary: Origin` to every response, because the value of
 * the header depends on the origin. For `*` or one fixed origin, the middleware sends the same CORS
 * headers on every response, without `Vary`, so that a cache can share the response, while the
 * browser compares the fixed origin with the origin of the page.
 *
 * A preflight request is an OPTIONS request with `Origin` and `Access-Control-Request-Method`. For
 * a preflight request from an allowed origin, the middleware returns a 204 itself, even on a path
 * with no route, and it passes a preflight request from any other origin on to the route. Add the
 * middleware to the app with `app.use()`, so that the package also calls it for a preflight
 * request to a path with no route. When you leave out `allowHeaders`, the middleware allows the
 * headers that the browser lists in the preflight request, up to 1,024 characters of valid header
 * names.
 *
 * @param options - You name the allowed origins, and you can set the methods, the headers, the
 * credentials, and the cache lifetime of the result of a preflight request.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when `origin` is missing or
 * malformed, when `credentials` is `true` with `*` or `null`, when a method or a header is not an
 * HTTP token, or when `maxAge` is not a whole number from 0 to 86,400.
 */
export function cors(options: CorsOptions): MiddlewareDefinition {
  const plan = corsPlan(optionsObject(options, 'cors()'))
  const declarations = { headers: [ORIGIN_HEADER], optionsHeaders: [REQUEST_METHOD_HEADER, REQUEST_HEADERS_HEADER] }
  const { staticOrigin } = plan
  if (staticOrigin !== undefined) {
    return { ...declarations, before: context => answerWithStaticOrigin(context, plan, staticOrigin) }
  }
  return {
    ...declarations,
    async handle(context, next) {
      const exchange = exchangeOf(context)
      const origin = context.req.header(ORIGIN_HEADER)
      if (origin === undefined || !(await allowsOrigin(plan.allowed, origin, context))) {
        await next()
        setFixed(exchange, plan.varyOrigin, true)
        return undefined
      }
      setPrepared(exchange, plan.allowOriginName, origin, false)
      if (plan.credentials !== undefined) setFixed(exchange, plan.credentials, false)
      if (isPreflight(context, origin)) {
        setFixed(exchange, plan.varyOrigin, true)
        answerPreflight(exchange, plan, context.req.header(REQUEST_HEADERS_HEADER))
        return createReply(PREFLIGHT_STATUS, undefined, null)
      }
      if (plan.expose !== undefined) setFixed(exchange, plan.expose, false)
      await next()
      setFixed(exchange, plan.varyOrigin, true)
      return undefined
    },
  }
}

function isPreflight(context: Context, origin: string | undefined): boolean {
  return (
    context.req.method === 'OPTIONS' && origin !== undefined && context.req.header(REQUEST_METHOD_HEADER) !== undefined
  )
}

function answerWithStaticOrigin(context: Context, plan: CorsPlan, staticOrigin: FixedHeader): Reply | undefined {
  const origin = context.req.header(ORIGIN_HEADER)
  const preflight = isPreflight(context, origin)
  if (preflight && plan.allowed.kind === 'single' && origin !== plan.allowed.origin) return undefined
  const exchange = exchangeOf(context)
  setFixed(exchange, staticOrigin, false)
  if (plan.credentials !== undefined) setFixed(exchange, plan.credentials, false)
  if (preflight) {
    answerPreflight(exchange, plan, context.req.header(REQUEST_HEADERS_HEADER))
    return createReply(PREFLIGHT_STATUS, undefined, null)
  }
  if (plan.expose !== undefined) setFixed(exchange, plan.expose, false)
  return undefined
}

function answerPreflight(exchange: Exchange, plan: CorsPlan, requested: string | undefined): void {
  setFixed(exchange, plan.methods, false)
  setFixed(exchange, plan.maxAge, false)
  if (plan.allowHeaders !== undefined) {
    setFixed(exchange, plan.allowHeaders, false)
    return
  }
  const echoed = echoedRequestHeaders(requested)
  if (echoed === undefined) return
  setPrepared(exchange, plan.allowHeadersName, echoed, false)
  setFixed(exchange, plan.varyRequestHeaders, true)
}
