import { DEFAULT_MAX_REQUEST_HEAD_BYTES, MAX_REQUEST_HEADER_COUNT, TEST_REQUEST_HOST } from '../constants.js'
import { parserRejectsFraming } from '../framing.js'
import { containsControlCharacter, containsSpaceOrControl, isToken } from '../headers.js'

const HOST_FORBIDDEN_PUNCTUATION = /[,@]/
const EDGE_WHITESPACE = /^[ \t]+|[ \t]+$/g
const CHUNKED = 'chunked'

type Lines = readonly (readonly [string, string])[]

/**
 * You pass request headers to {@link App.request} as an object or as a list of name and value
 * pairs. In the object form, you pass an array for a header that has several lines.
 */
export type TestHeaders = Readonly<Record<string, string | readonly string[]>> | readonly (readonly [string, string])[]

/**
 * You pass a request body to {@link App.request} as text, as bytes, or as a list or an async
 * iterable of chunks. {@link App.request} sends text and bytes with a `content-length` header, and
 * chunks with `transfer-encoding: chunked`, unless your headers set either one.
 */
export type TestBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | Iterable<string | Uint8Array>
  | AsyncIterable<string | Uint8Array>

/**
 * You pass these settings to {@link App.request}, which sends a request through the app without
 * a network.
 */
export interface TestRequestInit {
  /**
   * {@link App.request} sends this body in the chunks that you pass, so that a test can place a
   * chunk boundary anywhere in the body.
   */
  readonly body?: TestBody
  /** When you leave out the method, {@link App.request} sends a `GET`. */
  readonly method?: string
  /**
   * {@link App.request} lowercases each name. When these headers include no `host`, it sends
   * `host: localhost`, as `fetch` does.
   */
  readonly headers?: TestHeaders
  /** A handler gets this client address, which is `127.0.0.1` when you leave it out. */
  readonly clientAddress?: string
  /** When this signal fires, the package treats the client as gone. */
  readonly signal?: AbortSignal
}

/**
 * The package parses a test request into this form after it applies the checks of
 * uWebSockets.js.
 *
 * @internal
 */
export interface ParsedTestRequest {
  /** The test sent this method, and the package leaves its case unchanged. */
  readonly method: string
  /** The package split this raw path from the query string. */
  readonly path: string
  /** The package split this raw query string from the path. */
  readonly query: string
  /** The package lowercased the name and trimmed the value of every header line. */
  readonly lines: Lines
}

function entriesOf(headers: TestHeaders | undefined): (readonly [string, string])[] {
  if (headers === undefined) return []
  if (Array.isArray(headers)) return [...headers]
  const entries: (readonly [string, string])[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') entries.push([name, value])
    else for (const line of value) entries.push([name, line])
  }
  return entries
}

function maxHeadBytes(): number {
  const setting = process.env.UWS_HTTP_MAX_HEADERS_SIZE
  if (setting === undefined) return DEFAULT_MAX_REQUEST_HEAD_BYTES
  const parsed = Number.parseInt(setting, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

function headBytes(method: string, target: string, lines: Lines): number {
  let bytes = Buffer.byteLength(`${method} ${target} HTTP/1.1\r\n\r\n`)
  for (const [name, value] of lines) bytes += Buffer.byteLength(`${name}: ${value}\r\n`)
  return bytes
}

/**
 * Returns the value of every line of one header in a test request.
 *
 * @param lines - The package passes the header lines of the test request.
 * @param name - The package passes the lowercase name of the header.
 * @returns The function returns the values in the order of the lines.
 * @internal
 */
export function valuesOf(lines: Lines, name: string): string[] {
  return lines.filter(([lineName]) => lineName === name).map(([, value]) => value)
}

/**
 * Returns the length of a body that a test passed whole, or `undefined` for a body in chunks.
 *
 * @param body - The test passed this body.
 * @returns The function returns the length in bytes, counting text as UTF-8.
 * @internal
 */
export function wholeBodyLength(body: TestBody): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body)
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return body.byteLength
  return undefined
}

function addFraming(lines: (readonly [string, string])[], body: TestBody | undefined): void {
  if (body === undefined) return
  if (lines.some(([name]) => name === 'content-length' || name === 'transfer-encoding')) return
  const length = wholeBodyLength(body)
  lines.push(length === undefined ? ['transfer-encoding', CHUNKED] : ['content-length', String(length)])
}

function hostIsValid(lines: Lines): boolean {
  const hosts = lines.filter(([name]) => name === 'host')
  const [host] = hosts
  if (hosts.length !== 1 || host === undefined) return false
  return host[1] !== '' && !containsSpaceOrControl(host[1]) && !HOST_FORBIDDEN_PUNCTUATION.test(host[1])
}

/**
 * Returns a test request after the checks that uWebSockets.js v20.71.0 applies to every request.
 * The function returns `undefined` in each case in which uWebSockets.js sends a 400:
 *
 * - The function returns `undefined` for a method with a space or a control character, and for a
 *   target that does not start with `/` or that contains a space or a control character.
 * - It returns `undefined` for an invalid header name or a control character in a header value.
 * - It returns `undefined` for more than 98 header lines.
 * - It returns `undefined` when the request line and the headers take more than 4,096 bytes, or
 *   more than `UWS_HTTP_MAX_HEADERS_SIZE` where the host set it.
 * - It returns `undefined` for an empty, repeated, or invalid `Host`.
 * - It returns `undefined` for a request with both `content-length` and `transfer-encoding`, for
 *   a first `transfer-encoding` line that does not end with `chunked`, and for `content-length`
 *   lines that differ, that hold anything but digits, or whose value has more than 18 characters.
 *
 * @param target - The test passes the path with an optional query string.
 * @param init - The test passes the method, the headers, the client address, and the signal.
 * @returns The function returns the parsed request, or `undefined` for a 400.
 * @internal
 */
export function parseTestRequest(target: string, init: TestRequestInit): ParsedTestRequest | undefined {
  const method = init.method ?? 'GET'
  if (method === '' || containsSpaceOrControl(method)) return undefined
  if (!target.startsWith('/') || containsSpaceOrControl(target)) return undefined
  const lines: (readonly [string, string])[] = []
  for (const [name, value] of entriesOf(init.headers)) {
    if (!isToken(name) || containsControlCharacter(value, true)) return undefined
    lines.push([name.toLowerCase(), value.replace(EDGE_WHITESPACE, '')])
  }
  if (!lines.some(([name]) => name === 'host')) lines.unshift(['host', TEST_REQUEST_HOST])
  addFraming(lines, init.body)
  if (lines.length > MAX_REQUEST_HEADER_COUNT) return undefined
  if (headBytes(method, target, lines) > maxHeadBytes()) return undefined
  if (!hostIsValid(lines)) return undefined
  if (parserRejectsFraming(valuesOf(lines, 'content-length'), valuesOf(lines, 'transfer-encoding'))) return undefined
  const queryStart = target.indexOf('?')
  return {
    method,
    path: queryStart === -1 ? target : target.slice(0, queryStart),
    query: queryStart === -1 ? '' : target.slice(queryStart + 1),
    lines,
  }
}
