import { createHash } from 'node:crypto'
import { LOCK_INDEX } from '../../threads/constants.js'
import { acquireLock, releaseLock, type SharedRegion } from '../../threads/memory.js'
import {
  INLINE_KEY_BYTES,
  MAX_RATE_LIMIT,
  SLOT_WORDS,
  SWEEP_SPACING_DIVISOR,
  TABLE_HEADER_BYTES,
  TABLE_LOAD_FACTOR_INVERSE,
  TABLE_SWEPT_AT_BYTE,
  TABLE_USED_INDEX,
} from './constants.js'

const EMPTY = 0
const USED = 1
const STATE = 0
const COUNT = 1
const KEY_LENGTH = 2
const HASH = 3
const KEY = 4
const KEY_WORDS = INLINE_KEY_BYTES / Int32Array.BYTES_PER_ELEMENT
const HEADER_WORDS = TABLE_HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT
const SLOT_BYTES = SLOT_WORDS * Int32Array.BYTES_PER_ELEMENT + Float64Array.BYTES_PER_ELEMENT
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * A store returns the count of a key in its current window and the time at which that window ends,
 * in milliseconds since the epoch, in this form.
 */
export interface RateLimitHit {
  /** The client of the key sent this many requests in the current window, including this one. */
  readonly count: number
  /** The current window of the key ends at this time, in milliseconds since the epoch. */
  readonly resetAt: number
}

/**
 * Returns the number of slots of a table for a number of keys.
 *
 * @param maxKeys - The caller passes the number of keys.
 * @returns The function returns a power of two.
 * @internal
 */
export function capacityFor(maxKeys: number): number {
  return 2 ** Math.ceil(Math.log2(maxKeys * TABLE_LOAD_FACTOR_INVERSE))
}

/**
 * Returns the number of bytes of a table with a number of slots.
 *
 * @param capacity - The caller passes the number of slots.
 * @returns The function returns a multiple of 8.
 * @internal
 */
export function tableBytes(capacity: number): number {
  return TABLE_HEADER_BYTES + capacity * SLOT_BYTES
}

/**
 * The built-in store counts requests in this hash table, which it keeps in shared memory, so that
 * every worker thread of a server counts in the same table. Each method takes the lock of the
 * table, finds the slot of the key by linear probing, and then releases the lock. To delete a key,
 * the table shifts the later slots of the cluster back, so that a probe never has to pass a
 * tombstone.
 *
 * @internal
 */
export class CountTable {
  readonly #words: Int32Array
  readonly #resets: Float64Array
  readonly #sweptAt: Float64Array
  readonly #mask: number
  readonly #maxKeys: number
  readonly #key = new Uint8Array(INLINE_KEY_BYTES)
  readonly #keyWords = new Int32Array(this.#key.buffer)

  /**
   * Views a table in a region of shared memory.
   *
   * @param region - The caller passes the region, which has room for {@link tableBytes} bytes.
   * @param capacity - The caller passes the number of slots, a power of two.
   * @param maxKeys - The caller passes the largest number of keys that the table keeps.
   */
  constructor(region: SharedRegion, capacity: number, maxKeys: number) {
    const { memory, offset } = region
    this.#words = new Int32Array(memory, offset, HEADER_WORDS + capacity * SLOT_WORDS)
    const resetsOffset = offset + TABLE_HEADER_BYTES + capacity * SLOT_WORDS * Int32Array.BYTES_PER_ELEMENT
    this.#resets = new Float64Array(memory, resetsOffset, capacity)
    this.#sweptAt = new Float64Array(memory, offset + TABLE_SWEPT_AT_BYTE, 1)
    this.#mask = capacity - 1
    this.#maxKeys = maxKeys
  }

  #encode(key: string): { length: number; hash: number } {
    let bytes: Uint8Array = Buffer.from(key)
    let length = bytes.byteLength
    if (length > INLINE_KEY_BYTES) {
      bytes = createHash('sha256').update(bytes).digest()
      length = -bytes.byteLength
    }
    this.#key.fill(0)
    this.#key.set(bytes)
    let hash = FNV_OFFSET ^ length
    for (const byte of this.#key) hash = Math.imul(hash ^ byte, FNV_PRIME)
    return { length, hash: hash | 0 }
  }

  #base(slot: number): number {
    return HEADER_WORDS + slot * SLOT_WORDS
  }

  #matches(base: number, length: number, hash: number): boolean {
    const words = this.#words
    if (words[base + HASH] !== hash || words[base + KEY_LENGTH] !== length) return false
    for (let word = 0; word < KEY_WORDS; word++) {
      if (words[base + KEY + word] !== this.#keyWords[word]) return false
    }
    return true
  }

  /**
   * Counts one request of a key. When the window of the key has ended, the method starts a new
   * window of `windowMs` at `now`.
   *
   * @param key - The caller passes the key of the client.
   * @param windowMs - The caller passes the length of a window.
   * @param now - The caller passes the current time in milliseconds since the epoch.
   * @returns The method returns the count and the end of the window, or `undefined` when the
   * table already contains `maxKeys` keys and the key is new.
   */
  increment(key: string, windowMs: number, now: number): RateLimitHit | undefined {
    const { length, hash } = this.#encode(key)
    const words = this.#words
    acquireLock(words, LOCK_INDEX)
    try {
      let slot = (hash >>> 0) & this.#mask
      for (;;) {
        const base = this.#base(slot)
        if (words[base + STATE] === EMPTY) break
        if (this.#matches(base, length, hash)) {
          const resetAt = this.#resets[slot] ?? 0
          if (resetAt <= now) return this.#start(slot, base, windowMs, now)
          const count = Math.min((words[base + COUNT] ?? 0) + 1, MAX_RATE_LIMIT + 1)
          words[base + COUNT] = count
          return { count, resetAt }
        }
        slot = (slot + 1) & this.#mask
      }
      const used = words[TABLE_USED_INDEX] ?? 0
      if (used >= this.#maxKeys) return undefined
      const base = this.#base(slot)
      words[base + STATE] = USED
      words[base + KEY_LENGTH] = length
      words[base + HASH] = hash
      for (let word = 0; word < KEY_WORDS; word++) words[base + KEY + word] = this.#keyWords[word] ?? 0
      words[TABLE_USED_INDEX] = used + 1
      return this.#start(slot, base, windowMs, now)
    } finally {
      releaseLock(words, LOCK_INDEX)
    }
  }

  #start(slot: number, base: number, windowMs: number, now: number): RateLimitHit {
    const resetAt = now + windowMs
    this.#words[base + COUNT] = 1
    this.#resets[slot] = resetAt
    return { count: 1, resetAt }
  }

  /**
   * Deletes every key whose window has ended, unless another thread swept the table less than half
   * a window ago.
   *
   * @param windowMs - The caller passes the length of a window.
   * @param now - The caller passes the current time in milliseconds since the epoch.
   */
  sweep(windowMs: number, now: number): void {
    const words = this.#words
    acquireLock(words, LOCK_INDEX)
    try {
      if (now - (this.#sweptAt[0] ?? 0) < windowMs / SWEEP_SPACING_DIVISOR) return
      this.#sweptAt[0] = now
      let slot = 0
      while (slot <= this.#mask) {
        const base = this.#base(slot)
        if (words[base + STATE] === USED && (this.#resets[slot] ?? 0) <= now) this.#delete(slot)
        else slot++
      }
    } finally {
      releaseLock(words, LOCK_INDEX)
    }
  }

  #delete(slot: number): void {
    const words = this.#words
    let hole = slot
    let next = (hole + 1) & this.#mask
    while (words[this.#base(next) + STATE] === USED) {
      const home = ((words[this.#base(next) + HASH] ?? 0) >>> 0) & this.#mask
      const between = hole <= next ? hole < home && home <= next : hole < home || home <= next
      if (!between) {
        words.copyWithin(this.#base(hole), this.#base(next), this.#base(next) + SLOT_WORDS)
        this.#resets[hole] = this.#resets[next] ?? 0
        hole = next
      }
      next = (next + 1) & this.#mask
    }
    words.fill(0, this.#base(hole), this.#base(hole) + SLOT_WORDS)
    this.#resets[hole] = 0
    words[TABLE_USED_INDEX] = (words[TABLE_USED_INDEX] ?? 1) - 1
  }
}
