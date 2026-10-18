/** Every worker thread looks up the shared memory of the server on `globalThis` under this symbol name. */
export const SHARED_MEMORY_SYMBOL_NAME = '@delali/uhttp/shared-memory'

/** The shared memory of the server can grow to this many bytes. */
export const MAX_SHARED_MEMORY_BYTES = 1073741824

/** The shared memory has room for at most this many regions, one for each rate limiter that a worker builds. */
export const MAX_SHARED_REGIONS = 64

/** The first 32-bit word of the shared memory, and of each region, is a lock word, which contains the thread ID of its owner plus one, or 0 when no thread has taken the lock. */
export const LOCK_INDEX = 0

/** The second 32-bit word of the shared memory contains the byte offset of its first free byte. */
export const NEXT_FREE_INDEX = 1

/** The directory of regions starts at this 32-bit word, with two words, the offset and the size, for each region. */
export const DIRECTORY_INDEX = 2

/** The header of the shared memory has this many bytes, for the lock, the next free offset, and the directory. */
export const SHARED_MEMORY_HEADER_BYTES = 520

/** Each region starts at a multiple of this many bytes, so that a `Float64Array` can view it. */
export const SHARED_REGION_ALIGNMENT_BYTES = 8

/** A thread tries to take a lock this many times before it sleeps. */
export const LOCK_SPIN_LIMIT = 1000

/** A thread that waits for a lock sleeps for up to this many milliseconds between tries. */
export const LOCK_WAIT_MS = 1
