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
   * Counts one request of a key. When the table is full and the key is new, the store removes the
   * least recently used key of a sample and counts the new key in its place.
   *
   * @param key - The middleware passes the key of the client.
   * @param windowMs - The middleware passes the length of a window.
   * @returns The method returns the count and the end of the window.
   */
  increment(key: string, windowMs: number): RateLimitHit {
    return this.#table.increment(key, windowMs, Date.now())
  }

  /**
   * Returns `true` once, the first time after the full store removed a live key to make room for a
   * new one.
   *
   * @returns The method returns `false` when the store removed no live key since the last call.
   */
  takeEvictionWarning(): boolean {
    return this.#table.takeEviction()
  }
}
