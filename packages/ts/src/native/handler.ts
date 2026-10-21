import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { runChain } from '../chain.js'
import type { CompiledApp, CompiledRoute } from '../compile.js'
import { type Context, createContext } from '../context.js'
import { Exchange } from '../exchange/index.js'
import type { CopiedRequest } from '../request.js'
import { type DecodedChain, decodeChain, type RequestChain, resolveChain } from '../resolve.js'
import { attachBody } from './body.js'
import { watchAbort } from './close.js'
import { answerWhileClosing } from './closing.js'
import { copyRequest } from './copy.js'
import { directHandler } from './direct.js'
import { CLOSING, type Drain } from './drain.js'
import { crash, finish, finishLater } from './finish.js'
import { admittedFraming } from './framing.js'

type NativeHandler = (res: HttpResponse, req: HttpRequest) => void

const NO_PARAMETERS: readonly string[] = []
const MISSED_ROUTE_MESSAGE =
  'The package served a route that the JavaScript matcher matched after uWebSockets.js matched no route for this request.'

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

function respond(res: HttpResponse, exchange: Exchange, context: Context, chain: RequestChain): boolean {
  const pending = runChain(context, exchange, chain.layers, chain.handler)
  if (pending === undefined) return finish(res, exchange, context)
  finishLater(res, exchange, context, chain.limits.timeoutMs, pending)
  return false
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
 * While the server closes, the handler passes every request to {@link answerWhileClosing}.
 *
 * @param app - The package passes the compiled app.
 * @param route - The package passes the compiled route.
 * @param method - The route matches this method, which is `HEAD` for the route beside a GET route.
 * @param drain - The package passes the drain of the app of uWebSockets.js.
 * @returns The function returns the handler to register with uWebSockets.js.
 * @internal
 */
export function routeHandler(app: CompiledApp, route: CompiledRoute, method: string, drain: Drain): NativeHandler {
  const count = route.parameterNames.length
  const base: RequestChain = {
    layers: route.layers,
    handler: route.handler,
    copyPlan: route.copyPlan,
    parameterNames: route.parameterNames,
    rawParameters: NO_PARAMETERS,
    matchedRoute: true,
    route: route.path,
    limits: route.limits,
  }
  const withoutParameters: DecodedChain = { chain: base, parameters: NO_PARAMETERS }
  if (route.layers.length === 0 && !route.limits.readsBody && count === 0) {
    return directHandler(app, route, method, drain, withoutParameters)
  }
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
    const exchange = new Exchange(app.runtime, drain)
    const ended = drain.mode === CLOSING ? answerWhileClosing(res, req, exchange) : answer(res, req, exchange)
    if (!ended) watchAbort(res, exchange)
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
 * response ended inside it. While the server closes, the handler passes every request to
 * {@link answerWhileClosing}.
 *
 * @param app - The package passes the compiled app.
 * @param drain - The package passes the drain of the app of uWebSockets.js.
 * @returns The function returns the handler to register under `any('/*')`.
 * @internal
 */
export function fallbackHandler(app: CompiledApp, drain: Drain): NativeHandler {
  return (res, req) => {
    const exchange = new Exchange(app.runtime, drain)
    const ended =
      drain.mode === CLOSING ? answerWhileClosing(res, req, exchange) : answerFallback(app, res, req, exchange)
    if (!ended) watchAbort(res, exchange)
  }
}
