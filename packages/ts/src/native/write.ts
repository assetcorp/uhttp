import type { HttpResponse } from 'uWebSockets.js'
import { defaultErrorReply } from '../chain.js'
import { STATUS_TEXT } from '../constants.js'
import type { Context } from '../context.js'
import type { UhttpError } from '../errors.js'
import type { Exchange } from '../exchange.js'
import { bodyByteLength, errorReply, type Reply, statusHasBody } from '../reply.js'
import { followBody } from './body.js'
import { holdForBody } from './hold.js'
import { NativeStream } from './stream.js'

function statusLine(status: number): string {
  return `${status} ${STATUS_TEXT[status] ?? ''}`
}

function writeHead(res: HttpResponse, exchange: Exchange, reply: Reply): void {
  if (reply.status !== 200) res.writeStatus(statusLine(reply.status))
  const contentType = exchange.responseContentType()
  if (contentType !== undefined) res.writeHeader('content-type', contentType)
  exchange.forEachResponseHeader((name, value) => {
    res.writeHeader(name, value)
  })
}

function endWithoutBody(res: HttpResponse, length: number | undefined): void {
  if (length !== undefined) res.endWithoutBody(length)
  else res.endWithoutBody()
}

/**
 * Writes the current reply of a request to uWebSockets.js. For a reply with a body, the function
 * writes the status, the headers, and the body in one cork. For a streamed reply, it writes the
 * headers and then starts the producer. For a HEAD request, it writes the headers with the length
 * of the body, and it never calls a stream producer. The package discards the part of the request
 * body that your code left unread, so that the client can send its next request on the same
 * connection. When the client sent `Connection: close` and more of the body is still arriving, the
 * function waits for the last byte of the body before it ends the response.
 *
 * @param res - The package passes the response of uWebSockets.js, which the caller has corked.
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param context - The package passes the context of the request.
 * @param reply - The package passes the reply to write.
 * @internal
 */
export function writeReply(res: HttpResponse, exchange: Exchange, context: Context, reply: Reply): void {
  if (exchange.closed) return
  const stream = reply.stream
  const hasBody = statusHasBody(reply.status)
  const bodyless = context.req.method === 'HEAD' || !hasBody
  if (stream !== undefined && !bodyless) {
    exchange.body?.keepFlowing()
    writeHead(res, exchange, reply)
    new NativeStream(res, exchange, context, stream.length).start(stream.produce)
    return
  }
  exchange.settleBody()
  if (holdForBody(res, exchange, () => writeReply(res, exchange, context, reply))) return
  writeHead(res, exchange, reply)
  if (stream !== undefined) endWithoutBody(res, hasBody ? stream.length : undefined)
  else if (!hasBody) endWithoutBody(res, undefined)
  else if (bodyless) endWithoutBody(res, bodyByteLength(reply.body))
  else res.end(reply.body ?? '')
  exchange.end()
}

/**
 * Answers a request whose `transfer-encoding` the package rejects, before the package calls any
 * middleware or handler, and closes the connection after the reply. uWebSockets.js parses such a body as
 * chunked, so the function waits for its last byte before it ends the response.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @param exchange - The package passes the state of the request.
 * @param error - The package passes the `INVALID_TRANSFER_ENCODING` or the `UNSUPPORTED_TRANSFER_CODING` error.
 * @internal
 */
export function writeFramingRejection(res: HttpResponse, exchange: Exchange, error: UhttpError): void {
  exchange.closeConnection = true
  followBody(res, exchange)
  const reply = errorReply(error)
  const send = (): void => {
    if (exchange.closed) return
    res.writeStatus(statusLine(reply.status))
    if (reply.contentType !== undefined) res.writeHeader('content-type', reply.contentType)
    res.end(reply.body ?? '', true)
    exchange.end()
  }
  if (!holdForBody(res, exchange, send)) send()
}

/**
 * Writes the default 500 when the package fails before the chain can start. When even that write
 * fails, the function closes the connection.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @internal
 */
export function writeCrash(res: HttpResponse, exchange: Exchange): void {
  if (exchange.closed) return
  const reply = defaultErrorReply(undefined)
  try {
    res.cork(() => {
      res.writeStatus(statusLine(reply.status))
      if (reply.contentType !== undefined) res.writeHeader('content-type', reply.contentType)
      res.end(reply.body ?? '')
    })
    exchange.end()
  } catch {
    if (exchange.closed) return
    res.close()
    exchange.abort()
  }
}
