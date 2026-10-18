/** The cookie helpers take the cookies of a request from this header. */
export const COOKIE_HEADER = 'cookie'

/** The package sends each cookie in a line of this header. */
export const SET_COOKIE_HEADER = 'set-cookie'

/** The package throws for a cookie whose name and value have more than this many bytes together. */
export const MAX_COOKIE_BYTES = 4096

/** The package throws for a `Max-Age` above this many seconds, which is the 400 days for which browsers keep a cookie at most. */
export const MAX_COOKIE_MAX_AGE_SECONDS = 34560000

/** The middleware throws for a signing key shorter than this many bytes. */
export const MIN_COOKIE_KEY_BYTES = 20

/** The package signs a cookie with this HMAC hash. */
export const COOKIE_SIGNATURE_HASH = 'sha256'

/** An HMAC-SHA-256 signature has this many bytes. */
export const COOKIE_SIGNATURE_BYTES = 32

/** The package throws for a cookie whose name starts with this prefix, in any case, without `Secure`. */
export const SECURE_PREFIX = '__secure-'

/** The package throws for a cookie whose name starts with this prefix, in any case, unless the cookie has `Secure`, `Path=/`, and no `Domain`. */
export const HOST_PREFIX = '__host-'

/** The package sends this expiry date to delete a cookie. */
export const EPOCH_EXPIRY = 'Thu, 01 Jan 1970 00:00:00 GMT'
