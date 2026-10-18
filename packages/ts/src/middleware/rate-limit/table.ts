import { createHash, randomInt } from 'node:crypto'
import { UhttpError } from '../../errors.js'
import { LOCK_INDEX } from '../../threads/constants.js'
import { acquireLock, releaseLock, type SharedRegion } from '../../threads/memory.js'
import {
  EVICTION_SAMPLE_SIZE,
  INLINE_KEY_BYTES,
  MAX_RATE_LIMIT,
  SLOT_WORDS,
  SWEEP_SPACING_DIVISOR,
  TABLE_HEADER_BYTES,
  TABLE_LOAD_FACTOR_INVERSE,
  TABLE_SEED_INDEX,
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
const NO_SLOT = -1
const KEY_WORDS = INLINE_KEY_BYTES / Int32Array.BYTES_PER_ELEMENT
const HEADER_WORDS = TABLE_HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT
const SLOT_BYTES = SLOT_WORDS * Int32Array.BYTES_PER_ELEMENT + 2 * Float64Array.BYTES_PER_ELEMENT
const FNV_PRIME = 0x01000193
const MURMUR_FINAL_MULTIPLIER = 0x85ebca6b
const MURMUR_SECOND_FINAL_MULTIPLIER = 0xc2b2ae35
const MURMUR_HALF_SHIFT = 16
const MURMUR_MIDDLE_SHIFT = 13
const MAX_SEED = 0x7fffffff

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

function mixed(hash: number): number {
  let mixing = hash ^ (hash >>> MURMUR_HALF_SHIFT)
  mixing = Math.imul(mixing, MURMUR_FINAL_MULTIPLIER)
  mixing ^= mixing >>> MURMUR_MIDDLE_SHIFT
  mixing = Math.imul(mixing, MURMUR_SECOND_FINAL_MULTIPLIER)
  return mixing ^ (mixing >>> MURMUR_HALF_SHIFT)
}

function sharedSeed(words: Int32Array): number {
  acquireLock(words, LOCK_INDEX)
  try {
    if (words[TABLE_SEED_INDEX] === 0) words[TABLE_SEED_INDEX] = randomInt(1, MAX_SEED)
    return words[TABLE_SEED_INDEX] ?? 1
  } finally {
    releaseLock(words, LOCK_INDEX)
  }
}

/**
 * The built-in store counts requests in this hash table, which it keeps in shared memory, so that
 * every worker thread of a server counts in the same table. Each method takes the lock of the
 * table, finds the slot of the key by linear probing, and then releases the lock. The table hashes
 * each key with a random seed that every worker reads from the table header. When the table is
 * full, it removes the least recently used key of a sample to make room for a new key. To delete a
 * key, the table shifts the later slots of the cluster back, so that a probe never has to pass a
 * tombstone.
 *
 * @internal
 */
export class CountTable {
  readonly #words: Int32Array
  readonly #resets: Float64Array
  readonly #touched: Float64Array
  readonly #sweptAt: Float64Array
  readonly #mask: number
  readonly #maxKeys: number
  readonly #seed: number
  readonly #key = new Uint8Array(INLINE_KEY_BYTES)
  readonly #keyWords = new Int32Array(this.#key.buffer)
  #evicted = false

  /**
   * Views a table in a region of shared memory, and writes the seed of its hash when no worker has
   * written one yet.
   *
   * @param region - The caller passes the region, which has room for {@link tableBytes} bytes.
   * @param capacity - The caller passes the number of slots, a power of two.
   * @param maxKeys - The caller passes the largest number of keys that the table keeps.
   */
  constructor(region: SharedRegion, capacity: number, maxKeys: number) {
    const { memory, offset } = region
    const slotWordsEnd = offset + TABLE_HEADER_BYTES + capacity * SLOT_WORDS * Int32Array.BYTES_PER_ELEMENT
    this.#words = new Int32Array(memory, offset, HEADER_WORDS + capacity * SLOT_WORDS)
    this.#resets = new Float64Array(memory, slotWordsEnd, capacity)
    this.#touched = new Float64Array(memory, slotWordsEnd + capacity * Float64Array.BYTES_PER_ELEMENT, capacity)
    this.#sweptAt = new Float64Array(memory, offset + TABLE_SWEPT_AT_BYTE, 1)
    this.#mask = capacity - 1
    this.#maxKeys = maxKeys
    this.#seed = sharedSeed(this.#words)
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
    let hash = this.#seed ^ length
    for (const byte of this.#key) hash = Math.imul(hash ^ byte, FNV_PRIME)
    return { length, hash: mixed(hash) }
  }

  #base(slot: number): number {
    return HEADER_WORDS + slot * SLOT_WORDS
  }

  #used(slot: number): boolean {
    return this.#words[this.#base(slot) + STATE] === USED
  }

  #matches(base: number, length: number, hash: number): boolean {
    const words = this.#words
    if (words[base + HASH] !== hash || words[base + KEY_LENGTH] !== length) return false
    for (let word = 0; word < KEY_WORDS; word++) {
      if (words[base + KEY + word] !== this.#keyWords[word]) return false
    }
    return true
  }

  #probe(length: number, hash: number): number {
    let slot = (hash >>> 0) & this.#mask
    for (let step = 0; step <= this.#mask; step++) {
      const base = this.#base(slot)
      if (this.#words[base + STATE] === EMPTY || this.#matches(base, length, hash)) return slot
      slot = (slot + 1) & this.#mask
    }
    return NO_SLOT
  }

  /**
   * Counts one request of a key. When the window of the key has ended, the method starts a new
   * window of `windowMs` at `now`. When the key is new and the table already contains `maxKeys`
   * keys, the method first removes the least recently used key of a sample.
   *
   * @param key - The caller passes the key of the client.
   * @param windowMs - The caller passes the length of a window.
   * @param now - The caller passes the current time in milliseconds since the epoch.
   * @returns The method returns the count and the end of the window.
   */
  increment(key: string, windowMs: number, now: number): RateLimitHit {
    const { length, hash } = this.#encode(key)
    const words = this.#words
    acquireLock(words, LOCK_INDEX)
    try {
      let slot = this.#probe(length, hash)
      if (slot !== NO_SLOT && this.#used(slot)) return this.#count(slot, windowMs, now)
      if (slot === NO_SLOT || (words[TABLE_USED_INDEX] ?? 0) >= this.#maxKeys) {
        this.#evict(now)
        slot = this.#probe(length, hash)
        if (slot === NO_SLOT) {
          throw new UhttpError('INTERNAL_ERROR', 'The built-in store of rateLimit() found no free slot for a new key.')
        }
      }
      const base = this.#base(slot)
      words[base + STATE] = USED
      words[base + KEY_LENGTH] = length
      words[base + HASH] = hash
      for (let word = 0; word < KEY_WORDS; word++) words[base + KEY + word] = this.#keyWords[word] ?? 0
      words[TABLE_USED_INDEX] = (words[TABLE_USED_INDEX] ?? 0) + 1
      return this.#start(slot, windowMs, now)
    } finally {
      releaseLock(words, LOCK_INDEX)
    }
  }

  /**
   * Returns `true` once, the first time after the table removed a live key to make room for a new
   * one.
   *
   * @returns The method returns `false` when the table removed no live key since the last call.
   */
  takeEviction(): boolean {
    if (!this.#evicted) return false
    this.#evicted = false
    return true
  }

  #count(slot: number, windowMs: number, now: number): RateLimitHit {
    const resetAt = this.#resets[slot] ?? 0
    if (resetAt <= now) return this.#start(slot, windowMs, now)
    const base = this.#base(slot)
    const count = Math.min((this.#words[base + COUNT] ?? 0) + 1, MAX_RATE_LIMIT + 1)
    this.#words[base + COUNT] = count
    this.#touched[slot] = now
    return { count, resetAt }
  }

  #start(slot: number, windowMs: number, now: number): RateLimitHit {
    const resetAt = now + windowMs
    this.#words[this.#base(slot) + COUNT] = 1
    this.#resets[slot] = resetAt
    this.#touched[slot] = now
    return { count: 1, resetAt }
  }

  #evict(now: number): void {
    let slot = Math.floor(Math.random() * (this.#mask + 1))
    let victim = NO_SLOT
    let oldest = Number.POSITIVE_INFINITY
    let sampled = 0
    for (let step = 0; step <= this.#mask && sampled < EVICTION_SAMPLE_SIZE; step++) {
      if (this.#used(slot)) {
        sampled++
        if ((this.#resets[slot] ?? 0) <= now) {
          this.#delete(slot)
          return
        }
        const touched = this.#touched[slot] ?? 0
        if (touched < oldest) {
          oldest = touched
          victim = slot
        }
      }
      slot = (slot + 1) & this.#mask
    }
    if (victim === NO_SLOT) return
    this.#evicted = true
    this.#delete(victim)
  }

  /**
   * Deletes every key whose window has ended, unless another thread swept the table less than half
   * a window ago, and then counts the keys that are left, so that the number of keys stays right
   * even after a worker stopped in the middle of a change.
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
        if (this.#used(slot) && (this.#resets[slot] ?? 0) <= now) this.#delete(slot)
        else slot++
      }
      let used = 0
      for (let index = 0; index <= this.#mask; index++) {
        if (this.#used(index)) used++
      }
      words[TABLE_USED_INDEX] = used
    } finally {
      releaseLock(words, LOCK_INDEX)
    }
  }

  #delete(slot: number): void {
    const words = this.#words
    let hole = slot
    let next = (hole + 1) & this.#mask
    while (this.#used(next)) {
      const home = ((words[this.#base(next) + HASH] ?? 0) >>> 0) & this.#mask
      const between = hole <= next ? hole < home && home <= next : hole < home || home <= next
      if (!between) {
        words.copyWithin(this.#base(hole), this.#base(next), this.#base(next) + SLOT_WORDS)
        this.#resets[hole] = this.#resets[next] ?? 0
        this.#touched[hole] = this.#touched[next] ?? 0
        hole = next
      }
      next = (next + 1) & this.#mask
    }
    words.fill(0, this.#base(hole), this.#base(hole) + SLOT_WORDS)
    this.#resets[hole] = 0
    this.#touched[hole] = 0
    words[TABLE_USED_INDEX] = Math.max(0, (words[TABLE_USED_INDEX] ?? 1) - 1)
  }
}
