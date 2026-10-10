import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { CONNECTION_CLOSE_VALUE_LENGTH } from '../constants.js'
import type { UhttpError } from '../errors.js'
import type { Exchange } from '../exchange.js'
import { parserRejectsFraming, transferCodingError } from '../framing.js'
import { isDecimalDigits } from '../headers.js'

/**
 * The package reads these framing facts of a request from uWebSockets.js inside the synchronous
 * handler.
 *
 * @internal
 */
export interface RequestFraming {
  /** This holds the value of the first `content-length` line, or `undefined` when the request has none. */
  readonly contentLength: string | undefined
  /** This holds the value of the first `transfer-encoding` line, or `undefined` when the request has none. */
  readonly transferEncoding: string | undefined
  /** This is `true` when body bytes follow the head of the request. */
  readonly declaresBody: boolean
  /** This is `true` when uWebSockets.js closes the connection after the response, because the client sent `Connection: close`. */
  readonly clientCloses: boolean
  /** This is `true` when uWebSockets.js answers the request with its own 400 once the handler returns. */
  readonly parserRejects: boolean
  /** The package answers the request with this error before it calls any handler, and it is `undefined` otherwise. */
  readonly rejection: UhttpError | undefined
}

const refusedConnections = new Set<string>()

function connectionKey(res: HttpResponse): string {
  return `${Buffer.from(res.getRemoteAddressAsText()).toString()}:${res.getRemotePort()}`
}

/**
 * Marks the connection of a request whose framing the package rejects, so that the package refuses
 * every later request that uWebSockets.js parses on that connection. uWebSockets.js parses any
 * request that a client pipelines behind such a body in the same pass, which drops the close of the
 * connection, so without the mark the package can call the handler of the hidden request. The
 * package removes the mark one turn of the event loop after the response ends.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @param exchange - The package passes the state of the rejected request.
 * @internal
 */
export function refuseLaterRequests(res: HttpResponse, exchange: Exchange): void {
  const key = connectionKey(res)
  refusedConnections.add(key)
  exchange.onClose(() => {
    setImmediate(() => refusedConnections.delete(key))
  })
}

/**
 * Refuses a request that arrives on a connection that {@link refuseLaterRequests} marked. The
 * function starts no chain, and it closes the connection one turn of the event loop later, once
 * uWebSockets.js has sent the rejection of the earlier request.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @param exchange - The package passes the state of the request.
 * @returns The function returns `true` when it refused the request.
 * @internal
 */
export function refusedRequest(res: HttpResponse, exchange: Exchange): boolean {
  if (refusedConnections.size === 0 || !refusedConnections.has(connectionKey(res))) return false
  setImmediate(() => {
    if (exchange.closed) return
    res.close()
    exchange.abort()
  })
  return true
}

const NO_BODY: RequestFraming = {
  contentLength: undefined,
  transferEncoding: undefined,
  declaresBody: false,
  clientCloses: false,
  parserRejects: false,
  rejection: undefined,
}

/**
 * Returns the framing facts of a request. For a request without `content-length` and
 * `transfer-encoding`, the function makes two header lookups. For a request with either header, it
 * also walks every header, so that it finds repeated lines.
 *
 * @param req - The package passes the request of uWebSockets.js, which is valid until the handler returns.
 * @returns The function returns the framing facts.
 * @internal
 */
export function readFraming(req: HttpRequest): RequestFraming {
  const contentLength = req.getHeader('content-length')
  const transferEncoding = req.getHeader('transfer-encoding')
  if (contentLength === '' && transferEncoding === '') return NO_BODY
  const lengths: string[] = []
  const encodings: string[] = []
  req.forEach((name, value) => {
    if (name === 'content-length') lengths.push(value)
    else if (name === 'transfer-encoding') encodings.push(value)
  })
  const parserRejects = parserRejectsFraming(lengths, encodings)
  return {
    contentLength: contentLength === '' ? undefined : contentLength,
    transferEncoding: transferEncoding === '' ? undefined : transferEncoding,
    declaresBody: transferEncoding !== '' || (isDecimalDigits(contentLength) && Number(contentLength) > 0),
    clientCloses: req.getHeader('connection').length === CONNECTION_CLOSE_VALUE_LENGTH,
    parserRejects,
    rejection: parserRejects ? undefined : transferCodingError(encodings),
  }
}
