import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import type { BodyReader } from '../body/reader.js'
import { logServerError, runChain } from '../chain.js'
import type { CompiledApp, CompiledRoute, CopyPlan } from '../compile.js'
import { LIST_HEADER_NAMES } from '../constants.js'
import { type Context, createContext } from '../context.js'
import { startDeadline } from '../deadline.js'
import { Exchange } from '../exchange.js'
import { lineSeparatorOf } from '../headers.js'
import { CopiedRequest } from '../request.js'
import { type DecodedChain, decodeChain, type RequestChain, resolveChain } from '../resolve.js'
import { attachBody } from './body.js'
import { closeConnection, remoteAddressOf, watchAbort } from './close.js'
import { type RequestFraming, readFraming } from './framing.js'
import { refusedRequest } from './refuse.js'
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

/**
 * Copies the parts of a request that its chain declared, inside the synchronous handler of
 * uWebSockets.js.
 *
 * @param res - The package passes the response of uWebSockets.js, from which it reads the client address.
 * @param req - The package passes the request of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param method - The client sent this method.
 * @param path - The package passes the raw path without its query string.
 * @param decoded - The package passes the chain of the request with its decoded parameter values.
 * @param framing - The package passes the framing headers that it read from the request.
 * @param reader - The package passes the body reader, or `undefined` on a route without one.
 * @returns The function returns the copy of the request.
 * @internal
 */
export function copyRequest(
  res: HttpResponse,
  req: HttpRequest,
  exchange: Exchange,
  method: string,
  path: string,
  decoded: DecodedChain,
  framing: RequestFraming,
  reader: BodyReader | undefined,
): CopiedRequest {
  const { chain, parameters } = decoded
  const plan = chain.copyPlan
  const all = plan.allHeaders ? copyAllHeaders(req) : undefined
  const values = plan.allHeaders || plan.headerNames.length === 0 ? NO_VALUES : copyDeclaredHeaders(req, plan)
  const address = plan.clientAddress ? remoteAddressOf(res) : undefined
  return new CopiedRequest(
    exchange,
    method,
    path,
    req,
    chain.parameterNames,
    parameters,
    framing.contentLength,
    plan.headerNames,
    values,
    all,
    address,
    reader,
  )
}

function respondAndRelease(
  res: HttpResponse,
  exchange: Exchange,
  request: CopiedRequest,
  chain: RequestChain,
): boolean {
  const ended = respond(res, exchange, createContext(request, exchange), chain)
  request.release(!ended || exchange.reply?.stream !== undefined)
  return ended
}

/**
 * Returns the framing facts of a request that the package goes on to serve. For a request that
 * arrives on a refused connection, that uWebSockets.js answers with its own 400, or whose transfer
 * coding the package rejects, the function answers or leaves the request and returns `undefined`.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param req - The package passes the request of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @returns The function returns the framing facts, or `undefined` when no chain may start.
 * @internal
 */
export function admittedFraming(res: HttpResponse, req: HttpRequest, exchange: Exchange): RequestFraming | undefined {
  if (refusedRequest(res, exchange)) return undefined
  const framing = readFraming(req)
  if (framing.parserRejects) return undefined
  if (framing.rejection !== undefined) {
    writeFramingRejection(res, exchange, framing, framing.rejection, req.getCaseSensitiveMethod() === 'HEAD')
    return undefined
  }
  exchange.clientCloses = framing.clientCloses
  return framing
}

function respond(res: HttpResponse, exchange: Exchange, context: Context, chain: RequestChain): boolean {
  const pending = runChain(context, exchange, chain.layers, chain.handler)
  if (pending === undefined) return finish(res, exchange, context)
  finishLater(res, exchange, context, chain.limits.timeoutMs, pending)
  return false
}

function finishLater(
  res: HttpResponse,
  exchange: Exchange,
  context: Context,
  timeoutMs: number,
  pending: Promise<void>,
): void {
  const stop =
    timeoutMs > 0 ? startDeadline(exchange, context, timeoutMs, () => finishCorked(res, exchange, context)) : undefined
  pending.then(() => {
    if (exchange.timedOut) return
    stop?.()
    finishCorked(res, exchange, context)
  })
}

function finish(res: HttpResponse, exchange: Exchange, context: Context): boolean {
  const reply = exchange.reply
  if (exchange.closed) return true
  if (reply === undefined) return false
  try {
    return writeReply(res, exchange, context, reply)
  } catch (error) {
    return abandon(res, exchange, error, context)
  }
}

function finishCorked(res: HttpResponse, exchange: Exchange, context: Context): void {
  const reply = exchange.reply
  if (exchange.closed || reply === undefined) return
  try {
    res.cork(() => writeReply(res, exchange, context, reply))
  } catch (error) {
    abandon(res, exchange, error, context)
  }
}

/**
 * Logs an error that the package hit before the chain could start, and answers with the default 500.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param error - The package passes the error that it caught.
 * @param method - The client sent this method.
 * @param path - The package passes the path of the request.
 * @returns The function returns `true` when the response has ended or the connection has closed.
 * @internal
 */
export function crash(res: HttpResponse, exchange: Exchange, error: unknown, method: string, path: string): boolean {
  logServerError(exchange.runtime.logger, error, method, path)
  return writeCrash(res, exchange, method === 'HEAD')
}

function abandon(res: HttpResponse, exchange: Exchange, error: unknown, context: Context): boolean {
  logServerError(exchange.runtime.logger, error, context.req.method, context.req.path)
  closeConnection(res, exchange)
  return true
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
 * checks the `content-length` and `transfer-encoding` lines, and starts no chain for a request that
 * uWebSockets.js answers with its own 400 or whose transfer coding the package rejects. It then
 * copies the path parameters, the content length, the declared headers, and, where the chain
 * declared it, the client address. On a route without parameters, uWebSockets.js calls the handler
 * for the exact path of the route alone, so the function takes the path from the route and asks
 * uWebSockets.js for it on a route with parameters only. It then attaches the body reader on a
 * route with a body reader. When that work throws, the client receives a 500. The chain reads the
 * query string and the content type from uWebSockets.js when it first asks for them. Once the chain
 * returns, the function copies the parts that the chain has not read when the response stays open,
 * and releases the request of uWebSockets.js. Last, it attaches the abort handler unless the
 * response ended inside the handler.
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
  const answer = (res: HttpResponse, req: HttpRequest, exchange: Exchange): boolean => {
    let path = route.path
    let request: CopiedRequest
    let chain: RequestChain
    let decoded = withoutParameters
    try {
      const framing = admittedFraming(res, req, exchange)
      if (framing === undefined) return false
      if (count > 0) {
        path = req.getUrl()
        const raw: string[] = []
        for (let index = 0; index < count; index++) raw.push(req.getParameter(index) ?? '')
        decoded = decodeChain(app, { ...base, rawParameters: raw })
      }
      const opened = attachBody(res, exchange, decoded.chain, framing)
      chain = opened?.chain ?? decoded.chain
      request = copyRequest(res, req, exchange, method, path, decoded, framing, opened?.reader)
    } catch (error) {
      return crash(res, exchange, error, method, path)
    }
    return respondAndRelease(res, exchange, request, chain)
  }
  return (res, req) => {
    const exchange = new Exchange(app.runtime)
    if (!answer(res, req, exchange)) watchAbort(res, exchange)
  }
}

function answerFallback(app: CompiledApp, res: HttpResponse, req: HttpRequest, exchange: Exchange): boolean {
  let method = ''
  let path = ''
  let request: CopiedRequest
  let chain: RequestChain
  try {
    method = req.getCaseSensitiveMethod()
    const framing = admittedFraming(res, req, exchange)
    if (framing === undefined) return false
    path = req.getUrl()
    const resolved = resolveChain(app, method, path)
    if (resolved.matchedRoute) warnMissedRoute(app, method, path)
    const decoded = decodeChain(app, resolved)
    const opened = attachBody(res, exchange, decoded.chain, framing)
    chain = opened?.chain ?? decoded.chain
    request = copyRequest(res, req, exchange, method, path, decoded, framing, opened?.reader)
  } catch (error) {
    return crash(res, exchange, error, method, path)
  }
  return respondAndRelease(res, exchange, request, chain)
}

/**
 * Returns the uWebSockets.js handler for every request that no native route matches. After the same
 * framing checks as a route handler, the handler takes the method from the case-sensitive accessor
 * and sends the request through the JavaScript matcher. The client then receives a 404, a 405, or
 * the methods of the path for OPTIONS. When the JavaScript matcher matches a route there, the
 * handler serves it and logs a warning. Last, the handler attaches the abort handler unless the
 * response ended inside it.
 *
 * @param app - The package passes the compiled app.
 * @returns The function returns the handler to register under `any('/*')`.
 * @internal
 */
export function fallbackHandler(app: CompiledApp): NativeHandler {
  return (res, req) => {
    const exchange = new Exchange(app.runtime)
    if (!answerFallback(app, res, req, exchange)) watchAbort(res, exchange)
  }
}
