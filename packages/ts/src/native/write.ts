import type { HttpResponse } from 'uWebSockets.js'
import { defaultErrorReply } from '../chain.js'
import type { Context } from '../context.js'
import type { UhttpError } from '../errors.js'
import type { Exchange } from '../exchange.js'
import { bodyByteLength, errorReply, type Reply, statusHasBody } from '../reply.js'
import { followBody } from './body.js'
import { closeConnection } from './close.js'
import type { RequestFraming } from './framing.js'
import { statusLine, writeHead } from './head.js'
import { writeLingeringReply } from './linger.js'
import { refuseLaterRequests } from './refuse.js'
import { NativeStream } from './stream.js'

/**
 * Writes the current reply of a request to uWebSockets.js. For a reply with a body, the function
 * writes the status, the headers, and the body in one cork. For a streamed reply, it writes the
 * headers and then starts the producer. For a HEAD request, it writes the headers with the length
 * of the body, and it never calls a stream producer. The package discards the part of the request
 * body that your code left unread, and it closes the connection after the reply whenever
 * {@link Exchange.closesConnection} returns `true`.
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
  const head = context.req.method === 'HEAD'
  if (stream !== undefined && !head && hasBody) {
    exchange.body?.keepFlowing()
    writeHead(res, exchange, reply)
    if (exchange.serverCloses()) res.writeHeader('connection', 'close')
    new NativeStream(res, exchange, context, stream.length).start(stream.produce)
    return
  }
  exchange.settleBody()
  const close = exchange.closesConnection()
  const streamLength = stream?.length
  const lengthless = !hasBody || (stream !== undefined && streamLength === undefined)
  if (exchange.lingersAfterReply(lengthless)) {
    writeLingeringReply(res, exchange, reply, head)
    return
  }
  writeHead(res, exchange, reply)
  if (lengthless) res.endWithoutBody()
  else if (streamLength !== undefined) res.endWithoutBody(streamLength, close)
  else if (head) res.endWithoutBody(bodyByteLength(reply.body), close)
  else res.end(reply.body ?? '', close)
  exchange.end()
}

/**
 * Answers a request whose `transfer-encoding` the package rejects, before the package calls any
 * middleware or handler, and closes the connection after the reply. uWebSockets.js parses such a
 * body as chunked. When the body ends in the same pass of the parser as the head, the function
 * ends the response with a close, and {@link refuseLaterRequests} keeps any request that the
 * client hid behind the body from its handler. When more of the body is still on its way after that
 * pass, the function sends the reply as {@link writeLingeringReply} does, and uWebSockets.js
 * closes the connection if the client sends another request on it.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @param exchange - The package passes the state of the request.
 * @param framing - The package passes the framing headers of the request.
 * @param error - The package passes the `INVALID_TRANSFER_ENCODING` or the `UNSUPPORTED_TRANSFER_CODING` error.
 * @param head - The package passes `true` for a HEAD request, whose reply carries the length of the body alone.
 * @internal
 */
export function writeFramingRejection(
  res: HttpResponse,
  exchange: Exchange,
  framing: RequestFraming,
  error: UhttpError,
  head: boolean,
): void {
  exchange.closeAfterReply = true
  const reply = errorReply(error)
  exchange.assign(reply)
  refuseLaterRequests(res, exchange)
  followBody(res, exchange, framing)
  exchange.arrival.onEnd(() => {
    if (exchange.closed) return
    writeHead(res, exchange, reply)
    if (head) res.endWithoutBody(bodyByteLength(reply.body), true)
    else res.end(reply.body ?? '', true)
    exchange.end()
  })
  setImmediate(() => {
    if (!exchange.closed) res.cork(() => writeLingeringReply(res, exchange, reply, head))
  })
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
    closeConnection(res, exchange)
  }
}
