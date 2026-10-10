import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { logServerError, runChain } from '../chain.js'
import type { CompiledApp, CompiledRoute, CopyPlan } from '../compile.js'
import { LIST_HEADER_NAMES } from '../constants.js'
import { type Context, createContext } from '../context.js'
import { startDeadline } from '../deadline.js'
import { Exchange } from '../exchange.js'
import { lineSeparatorOf } from '../headers.js'
import { CopiedRequest } from '../request.js'
import { type DecodedChain, decodeChain, type PreparedRequest, type RequestChain, resolveChain } from '../resolve.js'
import { attachBody } from './body.js'
import { type RequestFraming, readFraming, refusedRequest, refuseLaterRequests } from './framing.js'
import { writeCrash, writeFramingRejection, writeReply } from './write.js'

type NativeHandler = (res: HttpResponse, req: HttpRequest) => void

const NO_VALUES: readonly (string | undefined)[] = []
const NO_PARAMETERS: readonly string[] = []
const MISSED_ROUTE_MESSAGE =
  'The package served a route that the JavaScript matcher matched after uWebSockets.js matched no route for this request.'

function copyAllHeaders(req: HttpRequest): Map<string, string> {
  const all = new Map<string, string>()
  req.forEach((name, value) => {
    if (value === '') return
    const earlier = all.get(name)
    if (earlier === undefined) all.set(name, value)
    else if (LIST_HEADER_NAMES.includes(name)) all.set(name, `${earlier}${lineSeparatorOf(name)}${value}`)
  })
  return all
}

function copyDeclaredHeaders(req: HttpRequest, plan: CopyPlan): (string | undefined)[] {
  const { headerNames, listHeaders } = plan
  const values: (string | undefined)[] = new Array(headerNames.length)
  for (let index = 0; index < headerNames.length; index++) {
    if (listHeaders[index] === true) continue
    const value = req.getHeader(headerNames[index] ?? '')
    values[index] = value === '' ? undefined : value
  }
  if (!plan.hasListHeader) return values
  req.forEach((name, value) => {
    if (value === '') return
    const index = headerNames.indexOf(name)
    if (index === -1 || listHeaders[index] !== true) return
    const earlier = values[index]
    values[index] = earlier === undefined ? value : `${earlier}${lineSeparatorOf(name)}${value}`
  })
  return values
}

function copyRequest(
  res: HttpResponse,
  req: HttpRequest,
  exchange: Exchange,
  method: string,
  path: string,
  decoded: DecodedChain,
  framing: RequestFraming,
): PreparedRequest {
  const query: string | undefined = req.getQuery()
  const rawContentType = req.getHeader('content-type')
  const { contentLength } = framing
  const { chain, parameters } = decoded
  const plan = chain.copyPlan
  const all = plan.allHeaders ? copyAllHeaders(req) : undefined
  const values = plan.allHeaders || plan.headerNames.length === 0 ? NO_VALUES : copyDeclaredHeaders(req, plan)
  const address = plan.clientAddress ? Buffer.from(res.getRemoteAddressAsText()).toString() : undefined
  const body = attachBody(res, req, exchange, chain, framing)
  const request = new CopiedRequest(
    exchange,
    method,
    path,
    query ?? '',
    chain.parameterNames,
    parameters,
    rawContentType === '' ? undefined : rawContentType,
    contentLength,
    plan.headerNames,
    values,
    all,
    address,
    body.reader,
  )
  return { context: createContext(request, exchange), chain: body.chain }
}

function admittedFraming(res: HttpResponse, req: HttpRequest, exchange: Exchange): RequestFraming | undefined {
  if (refusedRequest(res, exchange)) return undefined
  const framing = readFraming(req)
  if (framing.parserRejects) return undefined
  if (framing.rejection !== undefined) {
    refuseLaterRequests(res, exchange)
    writeFramingRejection(res, exchange, framing.rejection)
    return undefined
  }
  exchange.clientCloses = framing.clientCloses
  return framing
}

function respond(res: HttpResponse, exchange: Exchange, { context, chain }: PreparedRequest): void {
  const pending = runChain(context, exchange, chain.layers, chain.handler)
  if (pending === undefined) {
    finish(res, exchange, context, false)
    return
  }
  const { timeoutMs } = chain.limits
  const stop =
    timeoutMs > 0 ? startDeadline(exchange, context, timeoutMs, () => finish(res, exchange, context, true)) : undefined
  pending.then(() => {
    if (exchange.timedOut) return
    stop?.()
    finish(res, exchange, context, true)
  })
}

function finish(res: HttpResponse, exchange: Exchange, context: Context, cork: boolean): void {
  const reply = exchange.reply
  if (exchange.closed || reply === undefined) return
  try {
    if (cork) res.cork(() => writeReply(res, exchange, context, reply))
    else writeReply(res, exchange, context, reply)
  } catch (error) {
    logServerError(exchange.runtime.logger, error, context.req.method, context.req.path)
    writeCrash(res, exchange)
  }
}

function crash(res: HttpResponse, exchange: Exchange, error: unknown, method: string, path: string): void {
  logServerError(exchange.runtime.logger, error, method, path)
  writeCrash(res, exchange)
}

function warnMissedRoute(app: CompiledApp, method: string, path: string): void {
  try {
    app.runtime.logger?.warn({ method, path }, MISSED_ROUTE_MESSAGE)
  } catch {
    return
  }
}

/**
 * Returns the uWebSockets.js handler of one route. Inside the synchronous handler, the function
 * attaches the abort handler first. It then checks the `content-length` and `transfer-encoding`
 * lines, and starts no chain for a request that uWebSockets.js answers with its own 400 or whose
 * transfer coding the package rejects. It then copies the path, the query string, the path
 * parameters, the content type, the content length, the declared headers, and, where the chain
 * declared it, the client address. Last, it attaches the body reader on a route with a body
 * reader. When that work throws, the client receives a 500.
 *
 * @param app - The package passes the compiled app.
 * @param route - The package passes the compiled route.
 * @param method - The route matches this method, which is `HEAD` for the route beside a GET route.
 * @returns The function returns the handler to register with uWebSockets.js.
 * @internal
 */
export function routeHandler(app: CompiledApp, route: CompiledRoute, method: string): NativeHandler {
  const count = route.parameterNames.length
  const base: RequestChain = {
    layers: route.layers,
    handler: route.handler,
    copyPlan: route.copyPlan,
    parameterNames: route.parameterNames,
    rawParameters: NO_PARAMETERS,
    matchedRoute: true,
    limits: route.limits,
  }
  const withoutParameters: DecodedChain = { chain: base, parameters: NO_PARAMETERS }
  return (res, req) => {
    const exchange = new Exchange(app.runtime)
    res.onAborted(() => exchange.abort())
    let path = ''
    let copied: PreparedRequest
    let decoded = withoutParameters
    try {
      const framing = admittedFraming(res, req, exchange)
      if (framing === undefined) return
      path = req.getUrl()
      if (count > 0) {
        const raw: string[] = []
        for (let index = 0; index < count; index++) raw.push(req.getParameter(index) ?? '')
        decoded = decodeChain(app, { ...base, rawParameters: raw })
      }
      copied = copyRequest(res, req, exchange, method, path, decoded, framing)
    } catch (error) {
      crash(res, exchange, error, method, path)
      return
    }
    respond(res, exchange, copied)
  }
}

/**
 * Returns the uWebSockets.js handler for every request that no native route matches. After the same
 * framing checks as a route handler, the handler takes the method from the case-sensitive accessor
 * and sends the request through the JavaScript matcher. The client then receives a 404, a 405, or
 * the methods of the path for OPTIONS. When the JavaScript matcher matches a route there, the
 * handler serves it and logs a warning.
 *
 * @param app - The package passes the compiled app.
 * @returns The function returns the handler to register under `any('/*')`.
 * @internal
 */
export function fallbackHandler(app: CompiledApp): NativeHandler {
  return (res, req) => {
    const exchange = new Exchange(app.runtime)
    res.onAborted(() => exchange.abort())
    let method = ''
    let path = ''
    let copied: PreparedRequest
    try {
      const framing = admittedFraming(res, req, exchange)
      if (framing === undefined) return
      method = req.getCaseSensitiveMethod()
      path = req.getUrl()
      const chain = resolveChain(app, method, path)
      if (chain.matchedRoute) warnMissedRoute(app, method, path)
      copied = copyRequest(res, req, exchange, method, path, decodeChain(app, chain), framing)
    } catch (error) {
      crash(res, exchange, error, method, path)
      return
    }
    respond(res, exchange, copied)
  }
}
