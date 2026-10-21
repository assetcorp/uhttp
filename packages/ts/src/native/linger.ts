import type { HttpResponse } from 'uWebSockets.js'
import type { Exchange } from '../exchange/index.js'
import { type Reply, statusHasBody } from '../reply.js'
import { closeAfterLingering, watchAbort } from './close.js'
import { forEachHeaderLine, statusLine } from './head.js'

const CRLF = '\r\n'
const LAST_CHUNK = Buffer.from('\r\n0\r\n')

function headOf(lines: readonly string[]): Buffer {
  return Buffer.from(`${lines.join(CRLF)}${CRLF}`)
}

function responseBytes(exchange: Exchange, reply: Reply, head: boolean): Buffer {
  const lines = [statusLine(reply.status)]
  forEachHeaderLine(exchange, (name, value) => {
    lines.push(`${name}: ${value}`)
  })
  lines.push(`date: ${new Date().toUTCString()}`, 'connection: close')
  const { stream } = reply
  if (!statusHasBody(reply.status)) return headOf(lines)
  if (stream !== undefined) {
    if (stream.length !== undefined) lines.push(`content-length: ${stream.length}`)
    return headOf(lines)
  }
  const body = reply.body === null ? Buffer.alloc(0) : Buffer.from(reply.body)
  if (head || body.byteLength === 0) {
    lines.push(`content-length: ${body.byteLength}`)
    return headOf(lines)
  }
  lines.push('transfer-encoding: chunked', '', body.byteLength.toString(16))
  return Buffer.concat([headOf(lines), body, LAST_CHUNK])
}

/**
 * Sends a whole reply with `Connection: close` while the request body is still arriving, and lets
 * {@link closeAfterLingering} close the connection unless the client closes it first.
 * uWebSockets.js closes the socket as soon as a response that closes it ends. When unread request bytes remain in the socket
 * at that close, the operating system resets the connection, which can discard the reply before the
 * client reads it. The function therefore writes the whole response, framed as chunks or with a
 * length, through the status line of uWebSockets.js, which leaves the response open, so that the
 * package can close the connection later. Meanwhile, the package discards the rest of the body.
 * Because the response stays open, the function first attaches the abort handler with
 * {@link watchAbort}.
 *
 * @param res - The package passes the response of uWebSockets.js, which the caller has corked.
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param reply - The package passes the reply to write.
 * @param head - The package passes `true` for a HEAD request, whose reply carries the length of the body alone.
 * @internal
 */
export function writeLingeringReply(res: HttpResponse, exchange: Exchange, reply: Reply, head: boolean): void {
  watchAbort(res, exchange)
  res.writeStatus(responseBytes(exchange, reply, head))
  exchange.lingering = true
  exchange.end()
  closeAfterLingering(res, exchange)
}
