import type { HttpRequest, HttpResponse, us_socket_context_t } from 'uWebSockets.js'
import { logServerError, runChain } from '../chain.js'
import type { CompiledApp, CompiledWebSocket } from '../compile.js'
import { SWITCHING_PROTOCOLS_STATUS, UPGRADE_REPLY_HEADER_NAMES } from '../constants.js'
import { type Context, contextValues, createContext } from '../context.js'
import { startDeadline } from '../deadline.js'
import { Exchange } from '../exchange.js'
import { headerBytes } from '../headers.js'
import { attachBody } from '../native/body.js'
import { closeConnection, watchAbort } from '../native/close.js'
import { admittedFraming, copyRequest, crash } from '../native/handler.js'
import { statusLine } from '../native/head.js'
import { writeReply } from '../native/write.js'
import type { CopiedRequest } from '../request.js'
import { type DecodedChain, decodeChain, type RequestChain } from '../resolve.js'
import { acceptUpgrade, type HandshakeHeaders, handshakeError, handshakeOf, refuseUpgrade } from './handshake.js'
import type { Hub } from './hub.js'
import { NativeSocket, SOCKET_STATE } from './socket.js'

type UpgradeHandler = (res: HttpResponse, req: HttpRequest, context: us_socket_context_t) => void

const SWITCHING_STATUS_LINE = headerBytes(statusLine(SWITCHING_PROTOCOLS_STATUS))
const UPGRADE_METHOD = 'GET'
const NO_PARAMETERS: readonly string[] = []

interface Upgrade {
  readonly res: HttpResponse
  readonly exchange: Exchange
  readonly context: Context
  readonly handshake: HandshakeHeaders
  readonly socketContext: us_socket_context_t
  readonly hub: Hub
}

function switchProtocols(upgrade: Upgrade): void {
  const { res, exchange, context, handshake } = upgrade
  res.writeStatus(SWITCHING_STATUS_LINE)
  exchange.forEachResponseHeader((name, value) => {
    if (!UPGRADE_REPLY_HEADER_NAMES.includes(name)) res.writeHeader(name, value)
  })
  const socket = new NativeSocket(contextValues(context), upgrade.hub)
  res.upgrade(
    { [SOCKET_STATE]: socket },
    handshake.key,
    handshake.protocol ?? '',
    handshake.extensions ?? '',
    upgrade.socketContext,
  )
  exchange.end()
}

function finish(upgrade: Upgrade): boolean {
  const { res, exchange, context } = upgrade
  const reply = exchange.reply
  if (exchange.closed) return true
  if (reply === undefined) return false
  try {
    if (reply.status !== SWITCHING_PROTOCOLS_STATUS) return writeReply(res, exchange, context, reply)
    switchProtocols(upgrade)
    return true
  } catch (error) {
    logServerError(exchange.runtime.logger, error, context.req.method, context.req.path)
    closeConnection(res, exchange)
    return true
  }
}

function finishCorked(upgrade: Upgrade): void {
  if (upgrade.exchange.closed) return
  upgrade.res.cork(() => finish(upgrade))
}

function finishLater(upgrade: Upgrade, timeoutMs: number, pending: Promise<void>): void {
  const { exchange, context } = upgrade
  const stop = timeoutMs > 0 ? startDeadline(exchange, context, timeoutMs, () => finishCorked(upgrade)) : undefined
  pending.then(() => {
    if (exchange.timedOut) return
    stop?.()
    finishCorked(upgrade)
  })
}

function respond(upgrade: Upgrade, request: CopiedRequest, chain: RequestChain): boolean {
  const { exchange, context } = upgrade
  const pending = runChain(context, exchange, chain.layers, chain.handler)
  if (pending === undefined) {
    const ended = finish(upgrade)
    request.release(!ended || exchange.reply?.stream !== undefined)
    return ended
  }
  request.release(true)
  finishLater(upgrade, chain.limits.timeoutMs, pending)
  return false
}

/**
 * Returns the upgrade handler of one WebSocket route for uWebSockets.js, which calls it for a GET
 * request whose `sec-websocket-key` has 24 characters. Inside the synchronous handler, the function
 * applies the framing checks of an HTTP route, copies the path parameters, the declared headers,
 * and the handshake headers, and sends the request through the middleware chain of the route.
 * That chain ends in the 101 for a valid handshake, and in a 400, a 403, or a 426 otherwise. When
 * every middleware has returned, the package performs the upgrade inside a cork with the values
 * that the chain stored as the `data` of the socket, or it writes the reply that replaced the 101.
 * It attaches the abort handler before the handler of uWebSockets.js returns, unless the response
 * ended inside it.
 *
 * @param app - The package passes the compiled app.
 * @param socket - The package passes the compiled WebSocket route.
 * @param hub - The package passes the hub of the thread, through which every socket publishes.
 * @returns The function returns the handler to pass as `upgrade` to uWebSockets.js.
 * @internal
 */
export function upgradeHandler(app: CompiledApp, socket: CompiledWebSocket, hub: Hub): UpgradeHandler {
  const route = socket.upgrade
  const count = route.parameterNames.length
  const base: RequestChain = {
    layers: route.layers,
    handler: acceptUpgrade,
    copyPlan: route.copyPlan,
    parameterNames: route.parameterNames,
    rawParameters: NO_PARAMETERS,
    matchedRoute: true,
    limits: route.limits,
  }
  const withoutParameters: DecodedChain = { chain: base, parameters: NO_PARAMETERS }
  const answer = (res: HttpResponse, req: HttpRequest, socketContext: us_socket_context_t, exchange: Exchange) => {
    let path = route.path
    let request: CopiedRequest
    let chain: RequestChain
    let handshake: HandshakeHeaders
    try {
      const framing = admittedFraming(res, req, exchange)
      if (framing === undefined) return false
      let decoded = withoutParameters
      if (count > 0) {
        path = req.getUrl()
        const raw: string[] = []
        for (let index = 0; index < count; index++) raw.push(req.getParameter(index) ?? '')
        decoded = decodeChain(app, { ...base, rawParameters: raw })
      }
      handshake = handshakeOf(visit => req.forEach(visit))
      const error = handshakeError(handshake, socket.route.origins, framing.declaresBody)
      if (framing.declaresBody) exchange.closeAfterReply = true
      attachBody(res, exchange, decoded.chain, framing)
      chain =
        error !== undefined && decoded.chain.matchedRoute
          ? { ...decoded.chain, handler: refuseUpgrade(error) }
          : decoded.chain
      request = copyRequest(res, req, exchange, UPGRADE_METHOD, path, decoded, framing, undefined)
    } catch (error) {
      return crash(res, exchange, error, UPGRADE_METHOD, path)
    }
    const context = createContext(request, exchange)
    return respond({ res, exchange, context, handshake, socketContext, hub }, request, chain)
  }
  return (res, req, socketContext) => {
    const exchange = new Exchange(app.runtime)
    if (!answer(res, req, socketContext, exchange)) watchAbort(res, exchange)
  }
}
