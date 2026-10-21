import type { HttpResponse } from 'uWebSockets.js'
import { defaultErrorReply } from '../chain.js'
import type { Context } from '../context.js'
import type { UhttpError } from '../errors.js'
import { closesConnection, type Exchange, lingersAfterReply, serverCloses } from '../exchange/index.js'
import { bodyByteLength, errorReply, type Reply, statusHasBody } from '../reply.js'
import { followBody } from './body.js'
import { closeConnection, watchAbort } from './close.js'
import type { RequestFraming } from './framing.js'
import { foldedPlainHeadOf, okHeadOf, writeHead } from './head.js'
import { writeLingeringReply } from './linger.js'
import { refuseLaterRequests } from './refuse.js'
import { NativeStream } from './stream.js'

const OK_STATUS = 200

/**
 * Writes the current reply of a request to uWebSockets.js. For a reply with a body, the function
 * writes the status, the headers, and the body in one cork. For a streamed reply, it writes the
 * headers and then starts the producer. For a HEAD request, it writes the headers with the length
 * of the body, and it never calls a stream producer. The package discards the part of the request
 * body that your code left unread, and it closes the connection after the reply whenever
 * {@link Exchange.closesConnection} returns `true`. Before it starts a stream, the function attaches
 * the abort handler with {@link watchAbort}, because the response stays open.
 *
 * @param res - The package passes the response of uWebSockets.js, which the caller has corked.
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param context - The package passes the context of the request.
 * @param reply - The package passes the reply to write.
 * @returns The function returns `true` when the response has ended, and `false` when it stays open
 * for a stream or for a reply that closes the connection later.
 * @internal
 */
export function writeReply(res: HttpResponse, exchange: Exchange, context: Context, reply: Reply): boolean {
  if (exchange.closed) return true
  const head = context.req.method === 'HEAD'
  if (!head && writeReplyAlone(res, exchange, reply)) return true
  const stream = reply.stream
  if (stream !== undefined && !head && statusHasBody(reply.status)) {
    watchAbort(res, exchange)
    exchange.body?.keepFlowing()
    writeHead(res, exchange, reply)
    if (serverCloses(exchange)) res.writeHeader('connection', 'close')
    new NativeStream(res, exchange, context, stream.length).start(stream.produce)
    return false
  }
  return endReply(res, exchange, reply, head)
}

/**
 * Returns the head that uWebSockets.js writes in one call for a plain 200, which has no stream, no
 * header of its own, and a text or a JSON content type. When a middleware added one block of
 * default headers that it built at startup, such as the block of `secureHeaders()`, the head holds
 * that block too.
 *
 * @param exchange - The package passes the state of the request, which holds the default headers.
 * @param reply - The package passes the reply to write.
 * @returns The function returns the head of the reply, or `undefined` when the reply is not plain.
 * @internal
 */
export function plainHeadOf(exchange: Exchange, reply: Reply): ArrayBuffer | undefined {
  if (reply.status !== OK_STATUS || reply.stream !== undefined || reply.headers !== undefined) return undefined
  const blocks = exchange.defaultHeaders
  if (blocks === undefined) return okHeadOf(reply.contentType)
  return foldedPlainHeadOf(blocks, reply.contentType)
}

/**
 * Writes a plain 200 with a text or a JSON body, whose head the package built once as bytes, with
 * one call into uWebSockets.js for the head and one for the body. The function writes nothing when
 * the reply has another status, a stream, or headers of its own, when your code or a middleware set
 * a header, when a body is on its way, or when the connection closes after the response.
 *
 * @param res - The package passes the response of uWebSockets.js, which the caller has corked.
 * @param exchange - The package passes the state of the request, which is still open.
 * @param reply - The package passes the reply to write, to a request other than HEAD.
 * @returns The function returns `true` when it ended the response, and `false` when it wrote nothing.
 * @internal
 */
export function writeReplyAlone(res: HttpResponse, exchange: Exchange, reply: Reply): boolean {
  const okHead = plainHeadOf(exchange, reply)
  if (okHead === undefined || !exchange.writesReplyAlone()) return false
  res.writeStatus(okHead)
  res.end(reply.body ?? '')
  exchange.end()
  return true
}

function endReply(res: HttpResponse, exchange: Exchange, reply: Reply, head: boolean): boolean {
  exchange.settleBody()
  const close = closesConnection(exchange)
  const { stream } = reply
  const streamLength = stream?.length
  const lengthless = !statusHasBody(reply.status) || (stream !== undefined && streamLength === undefined)
  if (lingersAfterReply(exchange, lengthless)) {
    writeLingeringReply(res, exchange, reply, head)
    return false
  }
  writeHead(res, exchange, reply)
  if (lengthless) res.endWithoutBody()
  else if (streamLength !== undefined) res.endWithoutBody(streamLength, close)
  else if (head) res.endWithoutBody(bodyByteLength(reply.body), close)
  else if (close) res.end(reply.body ?? '', true)
  else res.end(reply.body ?? '')
  exchange.end()
  return true
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
 * Writes the default 500 when the package fails before the chain can start, while nothing of the
 * response has gone out. The function writes the 500 as {@link writeReply} writes a reply without a stream: it sends
 * no body to a HEAD request, it discards the rest of the request body, and it closes the connection
 * after the reply whenever {@link Exchange.closesConnection} returns `true`. When even that write
 * fails, the function closes the connection.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param head - The package passes `true` for a HEAD request, whose reply contains the length of the body and no body.
 * @returns The function returns `true` when the response ends or the connection closes, and `false`
 * when the response stays open for a reply that closes the connection later.
 * @internal
 */
export function writeCrash(res: HttpResponse, exchange: Exchange, head: boolean): boolean {
  return writeWholeReply(res, exchange, defaultErrorReply(undefined), head)
}

/**
 * Writes a reply that the package builds before it calls any middleware, in the way that
 * {@link writeReply} writes a reply without a stream. When that write fails, the function closes
 * the connection.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param reply - The package passes the reply, which has no stream.
 * @param head - The package passes `true` for a HEAD request, whose reply contains the length of the body and no body.
 * @returns The function returns `true` when the response ends or the connection closes, and `false`
 * when the response stays open for a reply that closes the connection later.
 * @internal
 */
export function writeWholeReply(res: HttpResponse, exchange: Exchange, reply: Reply, head: boolean): boolean {
  if (exchange.closed) return true
  exchange.assign(reply)
  let ended = true
  try {
    res.cork(() => {
      ended = endReply(res, exchange, reply, head)
    })
  } catch {
    closeConnection(res, exchange)
    return true
  }
  return ended
}
