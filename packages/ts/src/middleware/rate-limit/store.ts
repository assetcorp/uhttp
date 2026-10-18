import { claimSharedRegion } from '../../threads/memory.js'
import { CountTable, capacityFor, type RateLimitHit, tableBytes } from './table.js'

/**
 * You implement this interface to keep the counts of `rateLimit()` somewhere else, such as Redis,
 * so that several processes or machines share one count for each client.
 */
export interface RateLimitStore {
  /**
   * Counts one request of a key in its current fixed window. When the key has no window, or its
   * window has ended, your store starts a window of `windowMs` and counts the request as the first.
   *
   * @param key - The middleware passes the key of the client.
   * @param windowMs - The middleware passes the length of a window in milliseconds.
   * @returns Your store returns the count of the key in its window, including this request, and the
   * end of the window in milliseconds since the epoch, or a promise of both.
   */
  increment(key: string, windowMs: number): RateLimitHit | Promise<RateLimitHit>
}

/**
 * The built-in store of `rateLimit()` counts in a table in memory that every worker thread of a
 * server shares. It removes expired keys on a timer that never delays the exit of the process.
 *
 * @internal
 */
export class MemoryStore implements RateLimitStore {
  readonly #table: CountTable
  #full = false

  /**
   * Creates the store and starts its sweep timer.
   *
   * @param maxKeys - The caller passes the number of keys that the store keeps at most.
   * @param windowMs - The caller passes the length of a window, which is also the sweep interval.
   */
  constructor(maxKeys: number, windowMs: number) {
    const capacity = capacityFor(maxKeys)
    this.#table = new CountTable(claimSharedRegion(tableBytes(capacity)), capacity, maxKeys)
    const table = this.#table
    setInterval(() => table.sweep(windowMs, Date.now()), windowMs).unref()
  }

  /**
   * Counts one request of a key. When the table is full and the key is new, the store lets the
   * request through as the first of a window, so that the store keeps counting every client that
   * it already tracks.
   *
   * @param key - The middleware passes the key of the client.
   * @param windowMs - The middleware passes the length of a window.
   * @returns The method returns the count and the end of the window.
   */
  increment(key: string, windowMs: number): RateLimitHit {
    const now = Date.now()
    const hit = this.#table.increment(key, windowMs, now)
    if (hit !== undefined) return hit
    this.#full = true
    return { count: 1, resetAt: now + windowMs }
  }

  /**
   * Returns `true` once, the first time after the full store let a new key through without counting it.
   *
   * @returns The method returns `false` on every other call.
   */
  takeFullWarning(): boolean {
    if (!this.#full) return false
    this.#full = false
    return true
  }
}
