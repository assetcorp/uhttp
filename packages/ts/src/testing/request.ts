import { runChain } from '../chain.js'
import type { CompiledApp, CopyPlan } from '../compile.js'
import { LIST_HEADER_NAMES, TEST_CLIENT_ADDRESS } from '../constants.js'
import { type Context, createContext } from '../context.js'
import { UhttpError } from '../errors.js'
import { Exchange } from '../exchange.js'
import { lineSeparatorOf } from '../headers.js'
import { bodyByteLength, type Reply, statusHasBody } from '../reply.js'
import { CopiedRequest } from '../request.js'
import { type DecodedChain, decodeChain, resolveChain } from '../resolve.js'
import { type ParsedTestRequest, parseTestRequest, type TestRequestInit } from './parse.js'
import { testStreamBody } from './stream.js'

const PARSER_ERROR_BODY = '<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>'

type Lines = readonly (readonly [string, string])[]

function firstValue(lines: Lines, name: string): string | undefined {
  for (const [lineName, value] of lines) {
    if (lineName === name) return value === '' ? undefined : value
  }
  return undefined
}

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

function responseHeaders(exchange: Exchange): Headers {
  const headers = new Headers()
  const contentType = exchange.responseContentType()
  if (contentType !== undefined) headers.set('content-type', contentType)
  exchange.forEachResponseHeader((name, value) => {
    headers.append(name, value)
  })
  return headers
}

function toResponse(exchange: Exchange, context: Context, reply: Reply): Response {
  const headers = responseHeaders(exchange)
  const { status, stream } = reply
  const head = context.req.method === 'HEAD'
  if (!statusHasBody(status)) {
    exchange.end()
    return new Response(null, { status, headers })
  }
  if (stream !== undefined) {
    if (stream.length !== undefined) headers.set('content-length', String(stream.length))
    if (head) {
      exchange.end()
      return new Response(null, { status, headers })
    }
    return new Response(testStreamBody(exchange, context, stream.produce, stream.length), { status, headers })
  }
  headers.set('content-length', String(bodyByteLength(reply.body)))
  exchange.end()
  return new Response(head ? null : reply.body, { status, headers })
}

function copyTestRequest(
  exchange: Exchange,
  parsed: ParsedTestRequest,
  decoded: DecodedChain,
  clientAddress: string | undefined,
): Context {
  const { chain, parameters } = decoded
  const plan = chain.copyPlan
  const { lines } = parsed
  const request = new CopiedRequest(
    exchange,
    parsed.method,
    parsed.path,
    parsed.query,
    chain.parameterNames,
    parameters,
    firstValue(lines, 'content-type'),
    firstValue(lines, 'content-length'),
    plan.headerNames,
    plan.allHeaders ? [] : declaredValues(lines, plan),
    plan.allHeaders ? allHeaders(lines) : undefined,
    plan.clientAddress ? (clientAddress ?? TEST_CLIENT_ADDRESS) : undefined,
  )
  return createContext(request, exchange)
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
  const exchange = new Exchange(app.runtime)
  watchSignal(exchange, init.signal)
  const decoded = decodeChain(app, resolveChain(app, parsed.method, parsed.path))
  const context = copyTestRequest(exchange, parsed, decoded, init.clientAddress)
  await runChain(context, exchange, decoded.chain.layers, decoded.chain.handler)
  const reply = exchange.reply
  if (reply === undefined) throw new UhttpError('MISSING_REPLY', 'The middleware chain ended without a reply.')
  return toResponse(exchange, context, reply)
}
