import { type Context, exchangeOf } from '../../context.js'
import { UhttpError } from '../../errors.js'
import { type Exchange, setFixed, setPrepared } from '../../exchange/index.js'
import { isToken } from '../../headers.js'
import type { PreparedName } from '../../response.js'
import type { MiddlewareDefinition } from '../../types.js'
import { formatAddress, parseAddress } from '../address.js'
import { clientAddressOf } from '../client.js'
import { IPV6_BYTES } from '../constants.js'
import { logToApp } from '../logger.js'
import {
  booleanOption,
  type FixedHeader,
  fixedHeader,
  fixedName,
  invalidOption,
  isThenable,
  optionsObject,
  stringListOption,
  wholeNumberOption,
} from '../options.js'
import {
  DEFAULT_RATE_LIMIT_MAX_KEYS,
  IPV6_CLIENT_PREFIX,
  MAX_RATE_LIMIT,
  MAX_RATE_LIMIT_MAX_KEYS,
  MAX_RATE_LIMIT_WINDOW_MS,
  MIN_RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_POLICY_NAME,
  STORE_FULL_MESSAGE,
} from './constants.js'
import { MemoryStore, type RateLimitStore } from './store.js'
import type { RateLimitHit } from './table.js'

export type { RateLimitStore } from './store.js'
export type { RateLimitHit } from './table.js'

const MILLISECONDS_PER_SECOND = 1000
const BITS_PER_BYTE = 8

/**
 * You pass these options to {@link rateLimit}.
 */
export interface RateLimitOptions {
  /** The middleware lets this many requests of each key through in each window. */
  readonly limit: number
  /** Each fixed window lasts for this many milliseconds, from 1,000 up. */
  readonly windowMs: number
  /**
   * The middleware counts the requests of each key that this function returns, which can be async.
   * When you leave it out, the middleware counts the requests of each client address that
   * `clientAddressOf()` returns, and it groups IPv6 addresses by /64.
   *
   * @param context - The middleware passes the context of the request.
   * @returns The function returns the key.
   */
  readonly key?: (context: Context) => string | Promise<string>
  /**
   * The middleware declares these request headers, such as `x-api-key`, on every route that you add
   * it to, so that you can read them with `c.req.header()` in your `key` function.
   */
  readonly headers?: readonly string[]
  /**
   * The middleware counts in this store, such as one on Redis. When you leave it out, the middleware
   * counts in memory that every worker thread of the server shares.
   */
  readonly store?: RateLimitStore
  /** When this is `true`, the middleware also sends `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` on every response. */
  readonly legacyHeaders?: boolean
  /** The built-in store keeps at most this many keys, which is 10,000 by default. */
  readonly maxKeys?: number
}

interface LimitPlan {
  readonly limit: number
  readonly windowMs: number
  readonly key: ((context: Context) => string | Promise<string>) | undefined
  readonly headers: readonly string[]
  readonly store: RateLimitStore
  readonly memory: MemoryStore | undefined
  readonly policy: FixedHeader
  readonly legacyLimit: FixedHeader | undefined
  readonly names: LimitNames
}

interface LimitNames {
  readonly state: PreparedName
  readonly retryAfter: PreparedName
  readonly remaining: PreparedName
  readonly reset: PreparedName
}

function checkedStore(value: unknown): RateLimitStore | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'increment') !== 'function') {
    throw invalidOption('Pass a store with an increment method to rateLimit().')
  }
  return { increment: (key, windowMs) => Reflect.apply(Reflect.get(value, 'increment'), value, [key, windowMs]) }
}

function limitPlan(options: object): LimitPlan {
  const limit = wholeNumberOption(Reflect.get(options, 'limit'), 'the limit option of rateLimit()', 1, MAX_RATE_LIMIT)
  const windowMs = wholeNumberOption(
    Reflect.get(options, 'windowMs'),
    'the windowMs option of rateLimit()',
    MIN_RATE_LIMIT_WINDOW_MS,
    MAX_RATE_LIMIT_WINDOW_MS,
  )
  const key: unknown = Reflect.get(options, 'key')
  if (key !== undefined && typeof key !== 'function') {
    throw invalidOption('Set the key option of rateLimit() to a function.')
  }
  const headers = stringListOption(Reflect.get(options, 'headers'), 'the headers option of rateLimit()') ?? []
  for (const name of headers) {
    if (!isToken(name)) {
      throw invalidOption(
        `Write each entry of the headers option of rateLimit() as a header name, and '${name}' is not one.`,
      )
    }
  }
  const store = checkedStore(Reflect.get(options, 'store'))
  const maxKeys: unknown = Reflect.get(options, 'maxKeys')
  if (store !== undefined && maxKeys !== undefined) {
    throw invalidOption(
      'Leave out maxKeys when you pass a store to rateLimit(), because the package applies maxKeys to the built-in store alone.',
    )
  }
  const legacy = booleanOption(Reflect.get(options, 'legacyHeaders'), 'the legacyHeaders option of rateLimit()', false)
  let memory: MemoryStore | undefined
  let counter: RateLimitStore
  if (store === undefined) {
    const keys = maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS
    memory = new MemoryStore(
      wholeNumberOption(keys, 'the maxKeys option of rateLimit()', 1, MAX_RATE_LIMIT_MAX_KEYS),
      windowMs,
    )
    counter = memory
  } else {
    counter = store
  }
  const windowSeconds = Math.ceil(windowMs / MILLISECONDS_PER_SECOND)
  return {
    limit,
    windowMs,
    key: key === undefined ? undefined : context => Reflect.apply(key, undefined, [context]),
    headers,
    store: counter,
    memory,
    policy: fixedHeader('ratelimit-policy', `"${RATE_LIMIT_POLICY_NAME}";q=${limit};w=${windowSeconds}`),
    legacyLimit: legacy ? fixedHeader('x-ratelimit-limit', String(limit)) : undefined,
    names: {
      state: fixedName('ratelimit'),
      retryAfter: fixedName('retry-after'),
      remaining: fixedName('x-ratelimit-remaining'),
      reset: fixedName('x-ratelimit-reset'),
    },
  }
}

function addressKey(context: Context): string {
  const address = clientAddressOf(context)
  const parsed = address.includes(':') ? parseAddress(address) : undefined
  if (parsed === undefined || parsed.family !== 6) return address
  const prefixBytes = IPV6_CLIENT_PREFIX / BITS_PER_BYTE
  const bytes = new Uint8Array(IPV6_BYTES)
  bytes.set(parsed.bytes.subarray(0, prefixBytes))
  return `${formatAddress({ family: 6, bytes })}/${IPV6_CLIENT_PREFIX}`
}

function checkedHit(hit: unknown): RateLimitHit {
  const count: unknown = typeof hit === 'object' && hit !== null ? Reflect.get(hit, 'count') : undefined
  const resetAt: unknown = typeof hit === 'object' && hit !== null ? Reflect.get(hit, 'resetAt') : undefined
  if (
    typeof count !== 'number' ||
    typeof resetAt !== 'number' ||
    !Number.isFinite(count) ||
    !Number.isFinite(resetAt)
  ) {
    throw new UhttpError('INTERNAL_ERROR', 'The store of rateLimit() returned no numeric count and resetAt.')
  }
  return { count, resetAt }
}

function setHeaders(exchange: Exchange, plan: LimitPlan, hit: RateLimitHit, resetSeconds: number): void {
  const remaining = Math.max(0, plan.limit - hit.count)
  const { policy, legacyLimit, names } = plan
  setFixed(exchange, policy, false)
  setPrepared(exchange, names.state, `"${RATE_LIMIT_POLICY_NAME}";r=${remaining};t=${resetSeconds}`, false)
  if (legacyLimit === undefined) return
  setFixed(exchange, legacyLimit, false)
  setPrepared(exchange, names.remaining, String(remaining), false)
  setPrepared(exchange, names.reset, String(Math.ceil(hit.resetAt / MILLISECONDS_PER_SECOND)), false)
}

/**
 * Returns a middleware that limits each client to `limit` requests in each fixed window of
 * `windowMs`. Each window begins at the first request of a key. The package replies to a request
 * over the limit with a 429, the code `RATE_LIMITED`, and `Retry-After`, and it never calls the
 * handler for that request. The middleware sends `RateLimit-Policy` and `RateLimit` from the IETF
 * draft on rate-limit headers on every response, and with `legacyHeaders`, it also sends the
 * `X-RateLimit-*` names.
 *
 * By default, the middleware counts the requests of each client address in canonical form, so it
 * counts `::ffff:192.0.2.4` as `192.0.2.4`. It counts every IPv6 address in one /64 as one client.
 * Add `trustedProxies()` before this middleware when the app serves requests behind a proxy,
 * because otherwise the middleware will count every client as the proxy.
 *
 * The built-in store keeps its counts in memory that the worker threads of a server share, and it
 * removes expired keys on a timer. Build each rate limiter once, when Node loads the module of your
 * app, so that every worker counts its n-th rate limiter in the same table. When the store is full,
 * the package removes the least recently used key of a sample to count a new key, and it writes one
 * warning to the logger the first time that it removes a live key. With fixed windows, the
 * middleware can serve up to twice the limit around the end of a window.
 *
 * @param options - You set the limit and the window, and you can set the key, the headers that the
 * key function uses, the store, the legacy headers, and the size of the built-in store.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when `limit` is not a
 * whole number from 1 to 2,147,483,646, when `windowMs` is not a whole number from 1,000 to
 * 2,147,483,647, when `key` is not a function, when `headers` contains an entry that is not a
 * header name, when `store` has no `increment` method, or when `maxKeys` is not a whole number
 * from 1 to 1,048,576 or you pass it together with a `store`. It throws the same error when your app builds more
 * than 64 rate limiters with the built-in store, or when their tables need more than 1 GiB
 * together.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareDefinition {
  const plan = limitPlan(optionsObject(options, 'rateLimit()'))
  let warned = false
  const applyHit = (context: Context, value: unknown): void => {
    const hit = checkedHit(value)
    if (!warned && plan.memory?.takeEvictionWarning() === true) {
      warned = true
      logToApp(context, 'warn', {}, STORE_FULL_MESSAGE)
    }
    const resetSeconds = Math.max(0, Math.ceil((hit.resetAt - Date.now()) / MILLISECONDS_PER_SECOND))
    const exchange = exchangeOf(context)
    setHeaders(exchange, plan, hit, resetSeconds)
    if (hit.count > plan.limit) {
      setPrepared(exchange, plan.names.retryAfter, String(resetSeconds), false)
      throw new UhttpError(
        'RATE_LIMITED',
        `The client sent more requests than the limit of ${plan.limit} for one window.`,
      )
    }
  }
  const count = (context: Context, key: unknown): undefined | Promise<void> => {
    if (typeof key !== 'string') {
      throw new UhttpError('INTERNAL_ERROR', 'The key function of rateLimit() returned no string.')
    }
    const hit: unknown = plan.store.increment(key, plan.windowMs)
    if (isThenable(hit)) return Promise.resolve(hit).then(value => applyHit(context, value))
    applyHit(context, hit)
    return undefined
  }
  return {
    headers: plan.headers,
    clientAddress: true,
    before(context): undefined | Promise<void> {
      const key: unknown = plan.key === undefined ? addressKey(context) : plan.key(context)
      if (isThenable(key)) return Promise.resolve(key).then(value => count(context, value))
      return count(context, key)
    },
  }
}
