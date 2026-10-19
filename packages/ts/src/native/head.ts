import type { HttpResponse } from 'uWebSockets.js'
import { STATUS_TEXT } from '../constants.js'
import type { Exchange } from '../exchange.js'
import { headerBytes } from '../headers.js'
import { JSON_CONTENT_TYPE, type Reply, TEXT_CONTENT_TYPE } from '../reply.js'
import {
  type DefaultHeaders,
  type EncodedHeader,
  foldableDefaults,
  forEachDefaultHeader,
  forEachResponseHeader,
  forEachSetHeader,
  type HeaderVisitor,
  hasSetHeaders,
  responseContentType,
} from '../response.js'

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

const OK_STATUS = 200
const CONTENT_TYPE_NAME = headerBytes('content-type')
const TEXT_TYPE_BYTES = headerBytes(TEXT_CONTENT_TYPE)
const JSON_TYPE_BYTES = headerBytes(JSON_CONTENT_TYPE)
const OK_TEXT_HEAD = headerBytes(`${statusLine(OK_STATUS)}\r\ncontent-type: ${TEXT_CONTENT_TYPE}`)
const OK_JSON_HEAD = headerBytes(`${statusLine(OK_STATUS)}\r\ncontent-type: ${JSON_CONTENT_TYPE}`)

function contentTypeValue(contentType: string): string | ArrayBuffer {
  if (contentType === TEXT_CONTENT_TYPE) return TEXT_TYPE_BYTES
  if (contentType === JSON_CONTENT_TYPE) return JSON_TYPE_BYTES
  return contentType
}

function okHeadOf(contentType: string | undefined): ArrayBuffer | undefined {
  if (contentType === TEXT_CONTENT_TYPE) return OK_TEXT_HEAD
  if (contentType === JSON_CONTENT_TYPE) return OK_JSON_HEAD
  return undefined
}

function foldedHeadOf(block: DefaultHeaders, heads: Map<string, ArrayBuffer>, contentType: string): ArrayBuffer {
  const known = heads.get(contentType)
  if (known !== undefined) return known
  let text = `${statusLine(OK_STATUS)}\r\ncontent-type: ${contentType}`
  for (const header of block.headers) text += `\r\n${header.name}: ${header.value}`
  const built = headerBytes(text)
  heads.set(contentType, built)
  return built
}

/**
 * Calls a function with the content type and then with each line of every other header of the
 * current reply.
 *
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param emit - The package calls this function with the lowercase name and the value of each line.
 * @internal
 */
export function forEachHeaderLine(exchange: Exchange, emit: HeaderVisitor): void {
  const contentType = responseContentType(exchange)
  if (contentType !== undefined) emit('content-type', contentType, undefined)
  forEachResponseHeader(exchange, emit)
}

/**
 * Writes the status line and the headers of a reply to uWebSockets.js, which adds the framing
 * headers when the response ends. For a 200 with a text or a JSON content type, the function writes
 * the status line and the content type in one call, as bytes that it built once with
 * {@link headerBytes}, because uWebSockets.js writes the status that it receives as it is, followed
 * by a line break. When a middleware attached a fixed block of default headers that the package
 * sends whole, the function adds the block to the same bytes, which it builds once for each block
 * and content type. It passes only those fixed bytes that way, and every value that a reply or
 * your code sets goes through the header writer of uWebSockets.js.
 *
 * @param res - The package passes the response of uWebSockets.js, to which nothing has been written.
 * @param exchange - The package passes the state of the request, which stores the headers.
 * @param reply - The package passes the reply to write.
 * @internal
 */
export function writeHead(res: HttpResponse, exchange: Exchange, reply: Reply): void {
  const contentType = responseContentType(exchange)
  const okHead = reply.status === OK_STATUS ? okHeadOf(contentType) : undefined
  let firstDefaults = 0
  if (okHead !== undefined && contentType !== undefined) {
    const folded = exchange.defaultHeaders === undefined ? undefined : foldableDefaults(exchange)
    if (folded?.heads === undefined) {
      res.writeStatus(okHead)
    } else {
      res.writeStatus(foldedHeadOf(folded, folded.heads, contentType))
      firstDefaults = 1
    }
  } else {
    if (reply.status !== OK_STATUS) res.writeStatus(statusLine(reply.status))
    if (contentType !== undefined) res.writeHeader(CONTENT_TYPE_NAME, contentTypeValue(contentType))
  }
  if (hasSetHeaders(exchange))
    forEachSetHeader(exchange, (name, value, encoded) => writeLine(res, name, value, encoded))
  if (exchange.defaultHeaders !== undefined) {
    forEachDefaultHeader(exchange, (name, value, encoded) => writeLine(res, name, value, encoded), firstDefaults)
  }
}

function writeLine(res: HttpResponse, name: string, value: string, encoded: EncodedHeader | undefined): void {
  if (encoded === undefined) res.writeHeader(name, value)
  else res.writeHeader(encoded.name, encoded.value ?? value)
}
