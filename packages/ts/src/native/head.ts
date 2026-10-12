import type { HttpResponse } from 'uWebSockets.js'
import { STATUS_TEXT } from '../constants.js'
import type { Exchange } from '../exchange.js'
import { headerBytes } from '../headers.js'
import { JSON_CONTENT_TYPE, type Reply, TEXT_CONTENT_TYPE } from '../reply.js'

const CONTENT_TYPE_NAME = headerBytes('content-type')
const TEXT_TYPE_BYTES = headerBytes(TEXT_CONTENT_TYPE)
const JSON_TYPE_BYTES = headerBytes(JSON_CONTENT_TYPE)

function contentTypeValue(contentType: string): string | ArrayBuffer {
  if (contentType === TEXT_CONTENT_TYPE) return TEXT_TYPE_BYTES
  if (contentType === JSON_CONTENT_TYPE) return JSON_TYPE_BYTES
  return contentType
}

/**
 * Returns the status code and the reason phrase of a status line, such as `404 Not Found`.
 *
 * @param status - The package passes the status of the reply.
 * @returns The function returns the status line without the protocol version.
 * @internal
 */
export function statusLine(status: number): string {
  return `${status} ${STATUS_TEXT[status] ?? ''}`
}

/**
 * Calls a function with the content type and then with each line of every other header of the
 * current reply.
 *
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param emit - The package calls this function with the lowercase name and the value of each line.
 * @internal
 */
export function forEachHeaderLine(exchange: Exchange, emit: (name: string, value: string) => void): void {
  const contentType = exchange.responseContentType()
  if (contentType !== undefined) emit('content-type', contentType)
  exchange.forEachResponseHeader(emit)
}

/**
 * Writes the status line and the headers of a reply to uWebSockets.js, which adds the framing
 * headers when the response ends. The function passes the name of the content type, and its value
 * for a text or a JSON reply, as bytes that it built once with {@link headerBytes}.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param reply - The package passes the reply to write.
 * @internal
 */
export function writeHead(res: HttpResponse, exchange: Exchange, reply: Reply): void {
  if (reply.status !== 200) res.writeStatus(statusLine(reply.status))
  const contentType = exchange.responseContentType()
  if (contentType !== undefined) res.writeHeader(CONTENT_TYPE_NAME, contentTypeValue(contentType))
  if (exchange.hasResponseHeaders()) writeResponseHeaders(res, exchange)
}

function writeResponseHeaders(res: HttpResponse, exchange: Exchange): void {
  exchange.forEachResponseHeader((name, value) => {
    res.writeHeader(name, value)
  })
}
