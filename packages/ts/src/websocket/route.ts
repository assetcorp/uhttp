import {
  DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS,
  DEFAULT_WEBSOCKET_MAX_BACKPRESSURE_BYTES,
  DEFAULT_WEBSOCKET_MAX_LIFETIME_MS,
  DEFAULT_WEBSOCKET_MAX_MESSAGE_BYTES,
  MAX_WEBSOCKET_IDLE_TIMEOUT_MS,
  MAX_WEBSOCKET_LIFETIME_MS,
  MAX_WEBSOCKET_LIMIT_BYTES,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
  MIN_WEBSOCKET_BACKPRESSURE_BYTES,
  MIN_WEBSOCKET_IDLE_TIMEOUT_MS,
} from '../constants.js'
import { UhttpError } from '../errors.js'
import { checkedWholeNumber } from '../limits.js'
import type { WebSocketRoute } from './types.js'

type AnyRoute = WebSocketRoute<object>

/**
 * The package checks a {@link WebSocketRoute} into this form when you add the route, with every
 * limit in the unit that uWebSockets.js reads.
 *
 * @internal
 */
export interface CheckedWebSocketRoute {
  /** The package accepts an upgrade from these origins, and from the host of the request when this is `undefined`. */
  readonly origins: readonly string[] | undefined
  /** uWebSockets.js closes a socket whose message is longer than this many bytes. */
  readonly maxPayloadLength: number
  /** uWebSockets.js closes a socket after this many seconds without a message. */
  readonly idleTimeout: number
  /** uWebSockets.js closes a socket after this many minutes, and 0 means no limit. */
  readonly maxLifetime: number
  /** uWebSockets.js stops sending to a socket with more than this many bytes waiting. */
  readonly maxBackpressure: number
  /** uWebSockets.js closes a socket once it drops a message for backpressure when this is `true`. */
  readonly closeOnBackpressureLimit: boolean
  /** The package offers permessage-deflate with the shared compressor when this is `true`. */
  readonly compression: boolean
  /** The package calls this handler once a socket opens. */
  readonly open: AnyRoute['open']
  /** The package calls this handler for each message. */
  readonly message: AnyRoute['message']
  /** The package calls this handler once a full buffer drains. */
  readonly drain: AnyRoute['drain']
  /** The package calls this handler once a socket closes. */
  readonly close: AnyRoute['close']
}

function invalid(message: string): UhttpError {
  return new UhttpError('INVALID_ROUTE', message)
}

function wholeNumberIn(value: unknown, name: string, fallback: number, low: number, high: number): number {
  if (value === undefined) return fallback
  return checkedWholeNumber(value, 'INVALID_ROUTE', `${name} of a WebSocket route`, low, high)
}

function idleTimeoutOf(value: unknown): number {
  const milliseconds = wholeNumberIn(
    value,
    'idleTimeoutMs',
    DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS,
    MIN_WEBSOCKET_IDLE_TIMEOUT_MS,
    MAX_WEBSOCKET_IDLE_TIMEOUT_MS,
  )
  return Math.ceil(milliseconds / MILLISECONDS_PER_SECOND)
}

function maxLifetimeOf(value: unknown): number {
  const milliseconds = wholeNumberIn(
    value,
    'maxLifetimeMs',
    DEFAULT_WEBSOCKET_MAX_LIFETIME_MS,
    0,
    MAX_WEBSOCKET_LIFETIME_MS,
  )
  return Math.ceil(milliseconds / MILLISECONDS_PER_MINUTE)
}

function flagOf(value: unknown, name: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw invalid(`Set ${name} of a WebSocket route to true or false.`)
  return value
}

function handlerOf<T>(value: T | undefined, name: string): T | undefined {
  if (value !== undefined && typeof value !== 'function') {
    throw invalid(`Pass the ${name} handler of a WebSocket route as a function.`)
  }
  return value
}

/**
 * Returns an origin from an allow-list in the form that a browser sends in `Origin`, such as
 * `https://app.example.com`.
 *
 * @param entry - You pass one entry of the `origins` list of a WebSocket route.
 * @returns The function returns the origin with its scheme and host in lowercase and without a
 * default port.
 * @throws {@link UhttpError} with the code `INVALID_ROUTE` for anything other than an `http` or an
 * `https` origin without a path, a query, or credentials, which includes `null` and `*`.
 * @internal
 */
export function checkedOrigin(entry: unknown): string {
  const rule = `List each origin of a WebSocket route as a scheme and a host, such as 'https://app.example.com', and your code passed ${String(entry)}.`
  if (typeof entry !== 'string') throw invalid(rule)
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    throw invalid(rule)
  }
  const plain =
    url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === ''
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !plain || entry.endsWith('/')) throw invalid(rule)
  return url.origin
}

function originsOf(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalid('Set the origins of a WebSocket route to a list of origins.')
  return value.map(checkedOrigin)
}

/**
 * Returns `true` when a value can be the {@link WebSocketRoute} that you pass last to
 * {@link Group.ws}, which is an object without a `handle` function.
 *
 * @param value - The package checks the last argument of the route.
 * @returns The function returns `false` for a middleware definition and for anything other than an object.
 * @internal
 */
export function isWebSocketRoute(value: unknown): value is AnyRoute {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'handle') !== 'function'
}

/**
 * Returns a WebSocket route after checking each of its handlers and limits, so that a limit that
 * makes uWebSockets.js abort the process fails when you add the route.
 *
 * @param route - You pass the route that you gave to {@link Group.ws}.
 * @returns The function returns the checked route, with each limit in the unit that uWebSockets.js reads.
 * @throws {@link UhttpError} with the code `INVALID_ROUTE` when a handler is not a function or a
 * limit has the wrong type or lies outside its range.
 * @internal
 */
export function checkedWebSocketRoute(route: AnyRoute): CheckedWebSocketRoute {
  return {
    origins: originsOf(route.origins),
    maxPayloadLength: wholeNumberIn(
      route.maxMessageBytes,
      'maxMessageBytes',
      DEFAULT_WEBSOCKET_MAX_MESSAGE_BYTES,
      0,
      MAX_WEBSOCKET_LIMIT_BYTES,
    ),
    idleTimeout: idleTimeoutOf(route.idleTimeoutMs),
    maxLifetime: maxLifetimeOf(route.maxLifetimeMs),
    maxBackpressure: wholeNumberIn(
      route.maxBackpressureBytes,
      'maxBackpressureBytes',
      DEFAULT_WEBSOCKET_MAX_BACKPRESSURE_BYTES,
      MIN_WEBSOCKET_BACKPRESSURE_BYTES,
      MAX_WEBSOCKET_LIMIT_BYTES,
    ),
    closeOnBackpressureLimit: flagOf(route.closeOnBackpressureLimit, 'closeOnBackpressureLimit'),
    compression: flagOf(route.compression, 'compression'),
    open: handlerOf(route.open, 'open'),
    message: handlerOf(route.message, 'message'),
    drain: handlerOf(route.drain, 'drain'),
    close: handlerOf(route.close, 'close'),
  }
}
