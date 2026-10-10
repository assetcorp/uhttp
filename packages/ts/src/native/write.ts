import type { HttpResponse } from 'uWebSockets.js'
import { defaultErrorReply } from '../chain.js'
import { STATUS_TEXT } from '../constants.js'
import type { Context } from '../context.js'
import type { Exchange } from '../exchange.js'
import { bodyByteLength, type Reply, statusHasBody } from '../reply.js'
import { NativeStream } from './stream.js'

function statusLine(status: number): string {
  return `${status} ${STATUS_TEXT[status] ?? ''}`
}

function writeHead(res: HttpResponse, exchange: Exchange, reply: Reply): void {
  if (reply.status !== 200) res.writeStatus(statusLine(reply.status))
  const lines = exchange.headers
  const contentType = exchange.contentTypeOf(reply)
  if (contentType !== undefined) res.writeHeader('content-type', contentType)
  if (lines === undefined) return
  for (const [name, values] of lines) {
    if (name === 'content-type') continue
    for (const value of values) res.writeHeader(name, value)
  }
}

function endWithoutBody(res: HttpResponse, length: number | undefined): void {
  if (length === undefined) res.endWithoutBody()
  else res.endWithoutBody(length)
}

/**
 * Writes the current reply of a request to uWebSockets.js. For a reply with a body, the function
 * writes the status, the headers, and the body in one cork. For a streamed reply, it writes the
 * headers and then starts the producer. For a HEAD request, it writes the headers with the length
 * of the body, and it never calls a stream producer.
 *
 * @param res - The package passes the response of uWebSockets.js, which the caller has corked.
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param context - The package passes the context of the request.
 * @param reply - The package passes the reply to write.
 * @internal
 */
export function writeReply(res: HttpResponse, exchange: Exchange, context: Context, reply: Reply): void {
  if (exchange.closed) return
  writeHead(res, exchange, reply)
  const stream = reply.stream
  const hasBody = statusHasBody(reply.status)
  const bodyless = context.req.method === 'HEAD' || !hasBody
  if (stream !== undefined) {
    if (bodyless) {
      endWithoutBody(res, hasBody ? stream.length : undefined)
      exchange.end()
      return
    }
    new NativeStream(res, exchange, context, stream.length).start(stream.produce)
    return
  }
  if (!hasBody) endWithoutBody(res, undefined)
  else if (bodyless) endWithoutBody(res, bodyByteLength(reply.body))
  else res.end(reply.body ?? '')
  exchange.end()
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
