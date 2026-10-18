import { threadId } from 'node:worker_threads'
import { UhttpError } from '../errors.js'
import {
  DIRECTORY_INDEX,
  LOCK_INDEX,
  LOCK_SPIN_LIMIT,
  LOCK_WAIT_MS,
  MAX_SHARED_MEMORY_BYTES,
  MAX_SHARED_REGIONS,
  NEXT_FREE_INDEX,
  SHARED_MEMORY_HEADER_BYTES,
  SHARED_MEMORY_SYMBOL_NAME,
  SHARED_REGION_ALIGNMENT_BYTES,
} from './constants.js'

/**
 * A rate limiter keeps its table in this part of a shared buffer.
 *
 * @internal
 */
export interface SharedRegion {
  /** The package keeps the table in this buffer. */
  readonly memory: SharedArrayBuffer
  /** The table starts at this byte offset. */
  readonly offset: number
}

interface InstalledMemory {
  readonly memory: SharedArrayBuffer
  claimed: number
}

const OWNER = threadId + 1
const SHARED_MEMORY_KEY = Symbol.for(SHARED_MEMORY_SYMBOL_NAME)

/**
 * Returns the shared memory that the main thread passes to every worker of a server, so that the
 * workers can count requests in the same tables.
 *
 * @returns The function returns a growable buffer that contains an empty directory.
 * @internal
 */
export function createSharedMemory(): SharedArrayBuffer {
  const memory = new SharedArrayBuffer(SHARED_MEMORY_HEADER_BYTES, { maxByteLength: MAX_SHARED_MEMORY_BYTES })
  new Int32Array(memory)[NEXT_FREE_INDEX] = SHARED_MEMORY_HEADER_BYTES
  return memory
}

/**
 * Makes the shared memory of the server available to the rate limiters that this worker builds
 * when it loads the app module.
 *
 * @param memory - The worker passes the buffer that it received from the main thread.
 * @internal
 */
export function installSharedMemory(memory: SharedArrayBuffer): void {
  const installed: InstalledMemory = { memory, claimed: 0 }
  Reflect.set(globalThis, SHARED_MEMORY_KEY, installed)
}

/**
 * Takes a lock in shared memory. The thread tries a number of times and then sleeps between tries,
 * because a thread keeps a lock only while it probes a table and updates a slot.
 *
 * @param view - The caller passes a view of the memory that contains the lock.
 * @param index - The caller passes the index of the lock word in the view.
 * @internal
 */
export function acquireLock(view: Int32Array, index: number): void {
  let tries = 0
  while (Atomics.compareExchange(view, index, 0, OWNER) !== 0) {
    tries++
    if (tries > LOCK_SPIN_LIMIT) Atomics.wait(view, index, Atomics.load(view, index), LOCK_WAIT_MS)
  }
}

/**
 * Releases a lock that this thread has taken, and wakes one thread that waits for it.
 *
 * @param view - The caller passes a view of the memory that contains the lock.
 * @param index - The caller passes the index of the lock word in the view.
 * @internal
 */
export function releaseLock(view: Int32Array, index: number): void {
  Atomics.store(view, index, 0)
  Atomics.notify(view, index, 1)
}

/**
 * Releases every lock that a worker had taken when it exited, so that the other workers can use
 * every table after the main thread terminates a worker in the middle of an update.
 *
 * @param memory - The main thread passes the shared memory of the server.
 * @param workerThreadId - The main thread passes the thread ID of the worker that exited.
 * @internal
 */
export function releaseLocksOf(memory: SharedArrayBuffer, workerThreadId: number): void {
  const owner = workerThreadId + 1
  const view = new Int32Array(memory, 0, SHARED_MEMORY_HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT)
  for (let region = 0; region < MAX_SHARED_REGIONS; region++) {
    const offset = Atomics.load(view, DIRECTORY_INDEX + region * 2)
    if (offset === 0) continue
    const lock = new Int32Array(memory, offset, 1)
    if (Atomics.compareExchange(lock, LOCK_INDEX, owner, 0) === owner) Atomics.notify(lock, LOCK_INDEX)
  }
  if (Atomics.compareExchange(view, LOCK_INDEX, owner, 0) === owner) Atomics.notify(view, LOCK_INDEX)
}

function isInstalledMemory(value: unknown): value is InstalledMemory {
  if (typeof value !== 'object' || value === null) return false
  return Reflect.get(value, 'memory') instanceof SharedArrayBuffer && typeof Reflect.get(value, 'claimed') === 'number'
}

function installedMemory(): InstalledMemory | undefined {
  const installed: unknown = Reflect.get(globalThis, SHARED_MEMORY_KEY)
  return isInstalledMemory(installed) ? installed : undefined
}

function alignedSize(bytes: number): number {
  return Math.ceil(bytes / SHARED_REGION_ALIGNMENT_BYTES) * SHARED_REGION_ALIGNMENT_BYTES
}

function claimInstalled(installed: InstalledMemory, bytes: number): SharedRegion {
  const { memory } = installed
  const index = installed.claimed++
  if (index >= MAX_SHARED_REGIONS) {
    throw new UhttpError(
      'INVALID_MIDDLEWARE_OPTIONS',
      `Build at most ${MAX_SHARED_REGIONS} rate limiters with the built-in store in your app.`,
    )
  }
  const size = alignedSize(bytes)
  const view = new Int32Array(memory, 0, SHARED_MEMORY_HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT)
  const entry = DIRECTORY_INDEX + index * 2
  acquireLock(view, LOCK_INDEX)
  try {
    const existing = view[entry] ?? 0
    if (existing !== 0 && view[entry + 1] === size) return { memory, offset: existing }
    const offset = view[NEXT_FREE_INDEX] ?? SHARED_MEMORY_HEADER_BYTES
    if (offset + size > MAX_SHARED_MEMORY_BYTES) {
      throw new UhttpError(
        'INVALID_MIDDLEWARE_OPTIONS',
        `Lower the maxKeys of your rate limiters, because the package can reserve at most ${MAX_SHARED_MEMORY_BYTES} bytes of shared memory for their tables.`,
      )
    }
    if (memory.byteLength < offset + size) memory.grow(offset + size)
    view[NEXT_FREE_INDEX] = offset + size
    view[entry + 1] = size
    Atomics.store(view, entry, offset)
    return { memory, offset }
  } finally {
    releaseLock(view, LOCK_INDEX)
  }
}

/**
 * Returns the region of shared memory for the table of the next rate limiter that this thread
 * builds. In a worker of a server with `threads`, the function returns the same region for the
 * n-th rate limiter of every worker, so that the workers count each client together. A worker that
 * `server.reload()` starts reuses the region of the worker that it replaces. On any other thread,
 * the function returns a fresh buffer that the thread keeps to itself.
 *
 * @param bytes - The caller passes the size of the table in bytes, a multiple of 8.
 * @returns The function returns the region, whose bytes are all zero when the region is new.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when the worker builds
 * more than 64 rate limiters, or when their tables need more than 1 GiB together.
 * @internal
 */
export function claimSharedRegion(bytes: number): SharedRegion {
  const installed = installedMemory()
  if (installed === undefined) return { memory: new SharedArrayBuffer(alignedSize(bytes)), offset: 0 }
  return claimInstalled(installed, bytes)
}
