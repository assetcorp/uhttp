import { runChain } from '../chain.js'
import type { CompiledApp, CopyPlan } from '../compile.js'
import {
  CONNECTION_CLOSE_VALUE_LENGTH,
  LIST_HEADER_NAMES,
  SWITCHING_PROTOCOLS_STATUS,
  TEST_CLIENT_ADDRESS,
} from '../constants.js'
import { type Context, createContext } from '../context.js'
import { startDeadline } from '../deadline.js'
import { UhttpError } from '../errors.js'
import { Exchange } from '../exchange.js'
import { transferCodingError } from '../framing.js'
import { lineSeparatorOf } from '../headers.js'
import { bodyByteLength, errorReply, type Reply, statusHasBody } from '../reply.js'
import { CopiedRequest, type LiveRequest } from '../request.js'
import { type DecodedChain, decodeChain, type PreparedRequest, resolveChain } from '../resolve.js'
import { attachTestBody } from './body.js'
import { firstValue, type ParsedTestRequest, parseTestRequest, type TestRequestInit, valuesOf } from './parse.js'
import { testStreamBody } from './stream.js'
import { switchingResponse, testUpgradeOf } from './upgrade.js'

const PARSER_ERROR_BODY = '<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>'

interface CopiedTestRequest extends PreparedRequest {
  readonly request: CopiedRequest
}

type Lines = readonly (readonly [string, string])[]

function joinedValue(lines: Lines, name: string): string | undefined {
  const values = lines.filter(([lineName, value]) => lineName === name && value !== '').map(([, value]) => value)
  return values.length === 0 ? undefined : values.join(lineSeparatorOf(name))
}

function allHeaders(lines: Lines): Map<string, string> {
  const all = new Map<string, string>()
  for (const [name, value] of lines) {
    if (value === '' || all.has(name)) continue
    all.set(name, LIST_HEADER_NAMES.includes(name) ? (joinedValue(lines, name) ?? value) : value)
  }
  return all
}

function declaredValues(lines: Lines, plan: CopyPlan): (string | undefined)[] {
  return plan.headerNames.map((name, index) =>
    plan.listHeaders[index] === true ? joinedValue(lines, name) : firstValue(lines, name),
  )
}

function parserErrorResponse(): Response {
  return new Response(PARSER_ERROR_BODY, { status: 400, headers: { connection: 'close' } })
}

function framingRejectionResponse(error: UhttpError, head: boolean): Response {
  const reply = errorReply(error)
  const headers = new Headers({ connection: 'close', 'content-length': String(bodyByteLength(reply.body)) })
  if (reply.contentType !== undefined) headers.set('content-type', reply.contentType)
  return new Response(head ? null : reply.body, { status: reply.status, headers })
}

function responseHeaders(exchange: Exchange): Headers {
  const headers = new Headers()
  const contentType = exchange.response.contentType()
  if (contentType !== undefined) headers.set('content-type', contentType)
  exchange.response.forEachHeader((name, value) => {
    headers.append(name, value)
  })
  return headers
}

function toResponse(exchange: Exchange, context: Context, reply: Reply): Response {
  const headers = responseHeaders(exchange)
  const { status, stream } = reply
  const head = context.req.method === 'HEAD'
  if (stream !== undefined && !head && statusHasBody(status)) {
    if (exchange.serverCloses()) headers.set('connection', 'close')
    if (stream.length !== undefined) headers.set('content-length', String(stream.length))
    return new Response(testStreamBody(exchange, context, stream.produce, stream.length), { status, headers })
  }
  exchange.settleBody()
  const lengthless = !statusHasBody(status) || (stream !== undefined && stream.length === undefined)
  const lingers = exchange.lingersAfterReply(lengthless)
  if (lingers || (exchange.serverCloses() && !exchange.clientCloses)) headers.set('connection', 'close')
  exchange.end()
  if (!statusHasBody(status)) return new Response(null, { status, headers })
  if (stream !== undefined) {
    if (stream.length !== undefined) headers.set('content-length', String(stream.length))
    return new Response(null, { status, headers })
  }
  const length = bodyByteLength(reply.body)
  if (lingers && !head && length > 0) headers.set('transfer-encoding', 'chunked')
  else headers.set('content-length', String(length))
  return new Response(head ? null : reply.body, { status, headers })
}

function liveTestRequest(parsed: ParsedTestRequest): LiveRequest {
  const names = new TextDecoder()
  return {
    getQuery: () => parsed.query,
    getHeader: name => firstValue(parsed.lines, names.decode(name)) ?? '',
  }
}

function copyTestRequest(
  exchange: Exchange,
  parsed: ParsedTestRequest,
  decoded: DecodedChain,
  init: TestRequestInit,
): CopiedTestRequest {
  const { chain, parameters } = decoded
  const plan = chain.copyPlan
  const { lines } = parsed
  const { clientAddress } = init
  const body = attachTestBody(exchange, chain, lines, init.body)
  const request = new CopiedRequest(
    exchange,
    parsed.method,
    parsed.path,
    chain.route,
    liveTestRequest(parsed),
    chain.parameterNames,
    parameters,
    firstValue(lines, 'content-length'),
    plan.headerNames,
    plan.allHeaders ? [] : declaredValues(lines, plan),
    plan.allHeaders ? allHeaders(lines) : undefined,
    plan.clientAddress ? (clientAddress ?? TEST_CLIENT_ADDRESS) : undefined,
    body.reader,
  )
  return { context: createContext(request, exchange), chain: body.chain, request }
}

function keepsUnread(exchange: Exchange, reply: Reply): boolean {
  if (reply.stream !== undefined) return true
  return exchange.lingersAfterReply(!statusHasBody(reply.status))
}

async function untilReply(
  pending: Promise<void>,
  exchange: Exchange,
  context: Context,
  timeoutMs: number,
): Promise<unknown> {
  if (timeoutMs === 0) return pending
  const expired = Promise.withResolvers<void>()
  const stop = startDeadline(exchange, context, timeoutMs, () => expired.resolve())
  const finished = pending.then(() => {
    if (exchange.timedOut) return expired.promise
    stop()
    return undefined
  })
  return Promise.race([finished, expired.promise])
}

function watchSignal(exchange: Exchange, signal: AbortSignal | undefined): void {
  if (signal === undefined) return
  if (signal.aborted) {
    exchange.abort()
    return
  }
  const onAbort = (): void => exchange.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  exchange.onClose(() => signal.removeEventListener('abort', onAbort))
}

/**
 * Sends a request through the same matcher, middleware chain, and request context as a request
 * from the network, without uWebSockets.js, and returns what a client would receive.
 *
 * @param app - The package passes the compiled app.
 * @param target - The test passes the path with an optional query string.
 * @param init - The test passes the method, the headers, the client address, and the signal.
 * @returns The promise resolves to the status, the headers, and the body.
 * @internal
 */
export async function requestApp(app: CompiledApp, target: string, init: TestRequestInit): Promise<Response> {
  const parsed = parseTestRequest(target, init)
  if (parsed === undefined) return parserErrorResponse()
  const framingError = transferCodingError(valuesOf(parsed.lines, 'transfer-encoding'))
  if (framingError !== undefined) return framingRejectionResponse(framingError, parsed.method === 'HEAD')
  const exchange = new Exchange(app.runtime)
  exchange.clientCloses = (firstValue(parsed.lines, 'connection') ?? '').length === CONNECTION_CLOSE_VALUE_LENGTH
  watchSignal(exchange, init.signal)
  const upgrade = testUpgradeOf(app, parsed)
  if (upgrade?.declaresBody === true) exchange.closeAfterReply = true
  const decoded = upgrade?.decoded ?? decodeChain(app, resolveChain(app, parsed.method, parsed.path))
  const { context, chain, request } = copyTestRequest(exchange, parsed, decoded, init)
  const pending = runChain(context, exchange, chain.layers, chain.handler)
  if (pending !== undefined) {
    request.release(true)
    await untilReply(pending, exchange, context, chain.limits.timeoutMs)
  }
  const reply = exchange.reply
  if (reply === undefined) throw new UhttpError('MISSING_REPLY', 'The middleware chain ended without a reply.')
  if (pending === undefined) request.release(keepsUnread(exchange, reply))
  if (upgrade !== undefined && reply.status === SWITCHING_PROTOCOLS_STATUS && !exchange.closed) {
    return switchingResponse(exchange, upgrade.handshake)
  }
  return toResponse(exchange, context, reply)
}
