/** The built-in store keeps at most this many keys by default, in a table of 2 MiB. */
export const DEFAULT_RATE_LIMIT_MAX_KEYS = 10000

/** The middleware throws for a `maxKeys` above this number. */
export const MAX_RATE_LIMIT_MAX_KEYS = 1048576

/** The middleware throws for a window shorter than this many milliseconds, because the middleware writes the window in whole seconds in its headers. */
export const MIN_RATE_LIMIT_WINDOW_MS = 1000

/** The middleware throws for a window longer than this many milliseconds, which is the longest interval of a Node timer. */
export const MAX_RATE_LIMIT_WINDOW_MS = 2147483647

/** The middleware throws for a limit above this number, because a slot of the built-in store can store a count of at most one more than this number. */
export const MAX_RATE_LIMIT = 2147483646

/** The header of a table of the built-in store has this many bytes, for the lock, the number of keys, and the time of the last sweep. */
export const TABLE_HEADER_BYTES = 16

/** The built-in store records the time of its last sweep as a float at this byte offset of the table header. */
export const TABLE_SWEPT_AT_BYTE = 8

/** The built-in store keeps the number of keys in this 32-bit word of the table header. */
export const TABLE_USED_INDEX = 1

/** Each slot of the built-in store has this many 32-bit words, for the state, the count, the key length, the hash, and the key. */
export const SLOT_WORDS = 14

/** The built-in store keeps a key of up to this many bytes as it is, and the SHA-256 digest of any longer key. */
export const INLINE_KEY_BYTES = 40

/** The built-in store sizes its table to the next power of two of this multiple of `maxKeys`, so that a probe stays short. */
export const TABLE_LOAD_FACTOR_INVERSE = 2

/** The built-in store sweeps expired keys at most once in this fraction of the window. */
export const SWEEP_SPACING_DIVISOR = 2

/** The middleware uses this name for its policy in `RateLimit-Policy` and `RateLimit`. */
export const RATE_LIMIT_POLICY_NAME = 'default'

/** The middleware groups IPv6 clients by this prefix length, because a host can generate new addresses within its /64 at any time, as it does for the temporary addresses of RFC 8981. */
export const IPV6_CLIENT_PREFIX = 64

/** The middleware writes this message to the logger once, the first time that the built-in store is full. */
export const STORE_FULL_MESSAGE =
  'The built-in store of rateLimit() is full at maxKeys keys, so the package let a request with a new key through without counting it. Raise maxKeys or use a store such as Redis.'
