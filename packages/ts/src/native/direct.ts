import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { settleError, settleResult } from '../chain.js'
import type { CompiledApp, CompiledRoute } from '../compile.js'
import { type Context, createContext, createLazyContext, releaseRequest } from '../context.js'
import { Exchange } from '../exchange/index.js'
import { Reply } from '../reply.js'
import { CopiedRequest, type ReleasableRequest, type RequestCopy } from '../request.js'
import type { DecodedChain } from '../resolve.js'
import { followBody } from './body.js'
import { watchAbort } from './close.js'
import { answerWhileClosing } from './closing.js'
import { copyRequest } from './copy.js'
import { CLOSING, type Drain } from './drain.js'
import { abandon, crash, finish, finishLater, finishPlainly } from './finish.js'
import { admitFraming, admittedFraming, NO_BODY, type RequestFraming, readFraming } from './framing.js'
import { refusesAnyConnection } from './refuse.js'
import { plainHeadOf } from './write.js'

type NativeHandler = (res: HttpResponse, req: HttpRequest) => void

const NO_VALUES: readonly (string | undefined)[] = []

function answerLater(
  res: HttpResponse,
  exchange: Exchange,
  context: Context,
  route: CompiledRoute,
  pending: undefined | Promise<void>,
): boolean {
  if (pending !== undefined) {
    finishLater(res, exchange, context, route.limits.timeoutMs, pending)
    releaseRequest(context, true)
    return false
  }
  return finishAndRelease(res, exchange, context)
}

function finishAndRelease(res: HttpResponse, exchange: Exchange, context: Context): boolean {
  const ended = finish(res, exchange, context)
  releaseRequest(context, !ended || exchange.reply?.stream !== undefined)
  return ended
}

function settle(
  res: HttpResponse,
  exchange: Exchange,
  context: Context,
  route: CompiledRoute,
  pending: undefined | Promise<void>,
): void {
  if (!answerLater(res, exchange, context, route, pending)) watchAbort(res, exchange)
}

function crashed(res: HttpResponse, exchange: Exchange, error: unknown, method: string, path: string): void {
  if (!crash(res, exchange, error, method, path)) watchAbort(res, exchange)
}

function answer(res: HttpResponse, exchange: Exchange, context: Context, route: CompiledRoute, head: boolean): boolean {
  let result: unknown
  try {
    result = route.handler(context)
  } catch (error) {
    return answerLater(res, exchange, context, route, settleError(context, exchange, error))
  }
  if (!(result instanceof Reply)) {
    return answerLater(res, exchange, context, route, settleResult(context, exchange, result))
  }
  exchange.assign(result)
  if (head || !finishPlainly(res, exchange, context, result)) return finishAndRelease(res, exchange, context)
  releaseRequest(context, false)
  return true
}

function answerCopied(
  res: HttpResponse,
  req: HttpRequest,
  exchange: Exchange,
  framing: RequestFraming,
  route: CompiledRoute,
  method: string,
  chain: DecodedChain,
): boolean {
  let request: ReleasableRequest
  try {
    if (framing.declaresBody) followBody(res, exchange, framing)
    request = copyRequest(res, req, exchange, method, route.path, chain, framing, undefined)
  } catch (error) {
    return crash(res, exchange, error, method, route.path)
  }
  return answer(res, exchange, createContext(request, exchange), route, method === 'HEAD')
}

function copiesLazily(route: CompiledRoute): boolean {
  const plan = route.copyPlan
  return !plan.allHeaders && plan.headerNames.length === 0 && !plan.clientAddress
}

/**
 * Returns the uWebSockets.js handler of a route without middleware, without path parameters, and
 * without a body reader. The handler makes the same framing checks as the handler of any other route,
 * and sends the request straight to the handler of the route. When the route declares no header and no
 * client address, and the request declares no body, the package copies the request only when your
 * code first reads `c.req`, and a plain 200 with a text or a JSON body goes out with one call into
 * uWebSockets.js for its head. V8 compiles that path into one function, so the package keeps every
 * step of it inside the handler.
 *
 * @param app - The package passes the compiled app.
 * @param route - The package passes the compiled route.
 * @param method - The route matches this method, which is `HEAD` for the route beside a GET route.
 * @param drain - The package passes the drain of the app of uWebSockets.js.
 * @param chain - The package passes the chain of the route with no parameter values.
 * @returns The function returns the handler to register with uWebSockets.js.
 * @internal
 */
export function directHandler(
  app: CompiledApp,
  route: CompiledRoute,
  method: string,
  drain: Drain,
  chain: DecodedChain,
): NativeHandler {
  const head = method === 'HEAD'
  const lazy = copiesLazily(route)
  const copy: RequestCopy = (exchange, live) =>
    new CopiedRequest(
      exchange,
      method,
      route.path,
      chain.chain,
      live,
      chain.parameters,
      undefined,
      route.copyPlan.headerNames,
      NO_VALUES,
      undefined,
      undefined,
      undefined,
    )
  const checked = (res: HttpResponse, req: HttpRequest, framing: RequestFraming | undefined): void => {
    const exchange = new Exchange(app.runtime, drain)
    let ended: boolean
    if (drain.mode === CLOSING) ended = answerWhileClosing(res, req, exchange)
    else {
      let admitted: RequestFraming | undefined
      try {
        admitted =
          framing === undefined ? admittedFraming(res, req, exchange) : admitFraming(res, req, exchange, framing)
      } catch (error) {
        crashed(res, exchange, error, method, route.path)
        return
      }
      if (admitted === undefined) ended = false
      else if (lazy && admitted === NO_BODY) {
        ended = answer(res, exchange, createLazyContext(copy, exchange, req), route, head)
      } else ended = answerCopied(res, req, exchange, admitted, route, method, chain)
    }
    if (!ended) watchAbort(res, exchange)
  }
  if (!lazy) return (res, req) => checked(res, req, undefined)
  return (res, req) => {
    if (drain.mode === CLOSING || refusesAnyConnection()) return checked(res, req, undefined)
    let framing: RequestFraming
    try {
      framing = readFraming(req)
    } catch (error) {
      return crashed(res, new Exchange(app.runtime, drain), error, method, route.path)
    }
    if (framing !== NO_BODY) return checked(res, req, framing)
    const exchange = new Exchange(app.runtime, drain)
    const context = createLazyContext(copy, exchange, req)
    let result: unknown
    try {
      result = route.handler(context)
    } catch (error) {
      return settle(res, exchange, context, route, settleError(context, exchange, error))
    }
    if (!(result instanceof Reply))
      return settle(res, exchange, context, route, settleResult(context, exchange, result))
    exchange.assign(result)
    const okHead = head ? undefined : plainHeadOf(result)
    if (okHead === undefined || exchange.closed || !exchange.writesReplyAlone()) {
      return settle(res, exchange, context, route, undefined)
    }
    try {
      res.writeStatus(okHead)
      res.end(result.body ?? '')
    } catch (error) {
      abandon(res, exchange, error, context)
      releaseRequest(context, false)
      return
    }
    exchange.end()
    releaseRequest(context, false)
  }
}
