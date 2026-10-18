import { createHash } from 'node:crypto'
import { declaresNoBody } from '../body/reader.js'
import type { CompiledApp } from '../compile.js'
import {
  STATUS_TEXT,
  SWITCHING_PROTOCOLS_STATUS,
  UPGRADE_REPLY_HEADER_NAMES,
  WEBSOCKET_ACCEPT_SUFFIX,
  WEBSOCKET_KEY_LENGTH,
} from '../constants.js'
import type { Exchange } from '../exchange.js'
import { type DecodedChain, decodeChain } from '../resolve.js'
import { splitPath } from '../router/index.js'
import {
  acceptUpgrade,
  type HandshakeHeaders,
  handshakeError,
  handshakeOf,
  refuseUpgrade,
} from '../websocket/handshake.js'
import { firstValue, type ParsedTestRequest } from './parse.js'

const ACCEPTED_BASE_STATUS = 200

/**
 * {@link App.request} passes an upgrade request to the middleware of its WebSocket route in this form.
 *
 * @internal
 */
export interface TestUpgrade {
  /** The package passes the request through this chain, whose last handler returns the 101 or throws the error of the handshake. */
  readonly decoded: DecodedChain
  /** The test sent these handshake headers. */
  readonly handshake: HandshakeHeaders
  /** This is `true` when body bytes follow the head of the request. */
  readonly declaresBody: boolean
}

/**
 * Returns the upgrade for a test request that uWebSockets.js passes to the upgrade handler of a
 * WebSocket route, which is a GET request to the path of the route whose `sec-websocket-key` has
 * 24 characters.
 *
 * @param app - The package passes the compiled app.
 * @param parsed - The package passes the parsed test request.
 * @returns The function returns the upgrade, or `undefined` for any other request.
 * @internal
 */
export function testUpgradeOf(app: CompiledApp, parsed: ParsedTestRequest): TestUpgrade | undefined {
  const { lines } = parsed
  if (parsed.method !== 'GET' || firstValue(lines, 'sec-websocket-key')?.length !== WEBSOCKET_KEY_LENGTH) {
    return undefined
  }
  const match = app.upgradeMatcher.match('GET', splitPath(parsed.path))
  if (match === undefined) return undefined
  const route = match.value.upgrade
  const decoded = decodeChain(app, {
    layers: route.layers,
    handler: acceptUpgrade,
    copyPlan: route.copyPlan,
    parameterNames: route.parameterNames,
    rawParameters: match.parameters,
    matchedRoute: true,
    route: route.path,
    limits: route.limits,
  })
  const handshake = handshakeOf(visit => {
    for (const [name, value] of lines) visit(name, value)
  })
  const declaresBody = !declaresNoBody({
    contentLength: firstValue(lines, 'content-length'),
    transferEncoding: firstValue(lines, 'transfer-encoding'),
  })
  const error = handshakeError(handshake, match.value.route.origins, declaresBody)
  if (error === undefined || !decoded.chain.matchedRoute) return { decoded, handshake, declaresBody }
  return {
    decoded: { ...decoded, chain: { ...decoded.chain, handler: refuseUpgrade(error) } },
    handshake,
    declaresBody,
  }
}

/**
 * Returns the 101 that uWebSockets.js sends for an accepted upgrade, with the headers that your
 * middleware set and with `sec-websocket-accept` computed from the key as RFC 6455 defines it. The
 * response has the first subprotocol that the client offered in `sec-websocket-protocol`, and no
 * `sec-websocket-extensions` header.
 *
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param handshake - The package passes the handshake headers of the request.
 * @returns The function returns a response whose status is 101.
 * @internal
 */
export function switchingResponse(exchange: Exchange, handshake: HandshakeHeaders): Response {
  const headers = new Headers()
  exchange.response.forEachHeader((name, value) => {
    if (!UPGRADE_REPLY_HEADER_NAMES.includes(name)) headers.append(name, value)
  })
  headers.set('upgrade', 'websocket')
  headers.set('connection', 'Upgrade')
  const accept = createHash('sha1').update(`${handshake.key}${WEBSOCKET_ACCEPT_SUFFIX}`).digest('base64')
  headers.set('sec-websocket-accept', accept)
  const protocol = handshake.protocol?.split(',')[0]
  if (protocol !== undefined && protocol !== '') headers.set('sec-websocket-protocol', protocol)
  exchange.end()
  const response = new Response(null, { status: ACCEPTED_BASE_STATUS, headers })
  Object.defineProperties(response, {
    status: { value: SWITCHING_PROTOCOLS_STATUS },
    statusText: { value: STATUS_TEXT[SWITCHING_PROTOCOLS_STATUS] },
    ok: { value: false },
  })
  return response
}
