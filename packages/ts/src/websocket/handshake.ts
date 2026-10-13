import { WEBSOCKET_VERSION } from '../constants.js'
import type { Context } from '../context.js'
import { UhttpError } from '../errors.js'
import { switchingReply } from '../reply.js'
import type { Handler } from '../types.js'

const BASE64_NONCE = /^[A-Za-z0-9+/]{22}==$/
const ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:']
const NULL_ORIGIN = 'null'

/**
 * The package reads these headers of an upgrade request inside the synchronous handler, before the
 * chain starts.
 *
 * @internal
 */
export interface HandshakeHeaders {
  /** The client sent this `sec-websocket-key`, which uWebSockets.js checked for 24 characters. */
  readonly key: string
  /** The client sent this `sec-websocket-version`, or none. */
  readonly version: string | undefined
  /** The client sent this `upgrade` header, or none. */
  readonly upgrade: string | undefined
  /** The client sent this `connection` header, or none. */
  readonly connection: string | undefined
  /** The client sent this `origin` header, or none. */
  readonly origin: string | undefined
  /** The client sent this `host` header, or none. */
  readonly host: string | undefined
  /** The client offered these subprotocols in `sec-websocket-protocol`, or none. */
  readonly protocol: string | undefined
  /** The client offered these extensions in `sec-websocket-extensions`, or none. */
  readonly extensions: string | undefined
}

const SINGLE_HEADERS: readonly string[] = ['sec-websocket-key', 'sec-websocket-version', 'origin', 'host']
const LIST_HEADERS: readonly string[] = ['upgrade', 'connection', 'sec-websocket-protocol', 'sec-websocket-extensions']

/**
 * Returns the handshake headers of an upgrade request. The function keeps the first line of
 * `sec-websocket-key`, `sec-websocket-version`, `origin`, and `host`, as uWebSockets.js does, and
 * joins every line of `upgrade`, `connection`, `sec-websocket-protocol`, and
 * `sec-websocket-extensions` with a comma.
 *
 * @param forEach - The package passes a function that calls its argument with the lowercase name
 * and the value of each header line.
 * @returns The function returns the headers, with an empty key when the request has none.
 * @internal
 */
export function handshakeOf(forEach: (visit: (name: string, value: string) => void) => void): HandshakeHeaders {
  const values = new Map<string, string>()
  forEach((name, value) => {
    if (value === '') return
    const earlier = values.get(name)
    if (earlier === undefined) {
      if (SINGLE_HEADERS.includes(name) || LIST_HEADERS.includes(name)) values.set(name, value)
    } else if (LIST_HEADERS.includes(name)) {
      values.set(name, `${earlier}, ${value}`)
    }
  })
  return {
    key: values.get('sec-websocket-key') ?? '',
    version: values.get('sec-websocket-version'),
    upgrade: values.get('upgrade'),
    connection: values.get('connection'),
    origin: values.get('origin'),
    host: values.get('host'),
    protocol: values.get('sec-websocket-protocol'),
    extensions: values.get('sec-websocket-extensions'),
  }
}

function hasToken(value: string | undefined, token: string): boolean {
  if (value === undefined) return false
  return value.split(',').some(part => part.trim().toLowerCase() === token)
}

function hostOf(scheme: string, host: string): string | undefined {
  let url: URL
  try {
    url = new URL(`${scheme}//${host}`)
  } catch {
    return undefined
  }
  const plain = url.username === '' && url.password === '' && url.pathname === '/' && url.search === ''
  return plain && url.hash === '' ? url.host : undefined
}

function originAllowed(headers: HandshakeHeaders, origins: readonly string[] | undefined): boolean {
  const { origin, host } = headers
  if (origin === undefined) return true
  if (origin === NULL_ORIGIN) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.origin !== origin || !ALLOWED_SCHEMES.includes(url.protocol)) return false
  if (origins !== undefined) return origins.includes(url.origin)
  if (host === undefined) return false
  return hostOf(url.protocol, host) === url.host
}

/**
 * Returns the error that refuses an upgrade request, or `undefined` for a request that the package
 * can accept. A request without an `origin` header passes the origin check, because a browser sends
 * the header with every upgrade and a client outside a browser can send any origin that it likes.
 *
 * @param headers - The package passes the handshake headers of the request.
 * @param origins - The package passes the `origins` list of the route, or `undefined` to accept an
 * origin whose host and port match the `host` header of the request.
 * @param declaresBody - The package passes `true` when body bytes follow the head of the request.
 * @returns The function returns an `INVALID_UPGRADE` error for a request that breaks RFC 6455, an
 * `UPGRADE_REQUIRED` error for a version other than 13, and a `FORBIDDEN_ORIGIN` error for the
 * `null` origin or an origin that the route doesn't accept.
 * @internal
 */
export function handshakeError(
  headers: HandshakeHeaders,
  origins: readonly string[] | undefined,
  declaresBody: boolean,
): UhttpError | undefined {
  if (!hasToken(headers.upgrade, 'websocket') || !hasToken(headers.connection, 'upgrade')) {
    return new UhttpError(
      'INVALID_UPGRADE',
      'A WebSocket upgrade request needs the headers upgrade: websocket and connection: upgrade.',
    )
  }
  if (!BASE64_NONCE.test(headers.key)) {
    return new UhttpError('INVALID_UPGRADE', 'The sec-websocket-key header must be 16 bytes in base64.')
  }
  if (declaresBody) return new UhttpError('INVALID_UPGRADE', 'Send a WebSocket upgrade request without a body.')
  if (headers.version !== WEBSOCKET_VERSION) {
    return new UhttpError(
      'UPGRADE_REQUIRED',
      `This server supports version ${WEBSOCKET_VERSION} of the WebSocket protocol alone.`,
    )
  }
  if (!originAllowed(headers, origins)) {
    return new UhttpError(
      'FORBIDDEN_ORIGIN',
      'The origin of the request fails the origin check of this WebSocket route.',
    )
  }
  return undefined
}

function announceUpgrade(context: Context): void {
  context.header('upgrade', 'websocket')
  context.header('sec-websocket-version', WEBSOCKET_VERSION)
}

/**
 * Answers a GET request to a WebSocket route that asks for no upgrade, with a 426 that names the
 * WebSocket protocol in `upgrade` and its version in `sec-websocket-version`.
 *
 * @param context - The package passes the context of the request.
 * @returns The function never returns.
 * @throws {@link UhttpError} with the code `UPGRADE_REQUIRED` every time.
 * @internal
 */
export const upgradeRequired: Handler = context => {
  announceUpgrade(context)
  throw new UhttpError('UPGRADE_REQUIRED', 'Send a WebSocket upgrade request to this path.')
}

/**
 * Accepts an upgrade request at the end of its chain with the 101 reply, which the package turns
 * into the upgrade once every middleware has returned.
 *
 * @returns The function returns the 101 reply.
 * @internal
 */
export const acceptUpgrade: Handler = () => switchingReply()

/**
 * Returns the handler that refuses an upgrade request at the end of its chain, so that every
 * middleware of the route receives the error reply after `await next()`. For an
 * `UPGRADE_REQUIRED` error, the reply has the version that the package supports in
 * `sec-websocket-version`.
 *
 * @param error - The package passes the error from {@link handshakeError}.
 * @returns The function returns a handler that throws the error.
 * @internal
 */
export function refuseUpgrade(error: UhttpError): Handler {
  return context => {
    if (error.code === 'UPGRADE_REQUIRED') announceUpgrade(context)
    throw error
  }
}
