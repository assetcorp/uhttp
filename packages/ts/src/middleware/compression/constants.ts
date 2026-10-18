/** The middleware compresses a body of at least this many bytes by default. */
export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024

/** The middleware throws for a threshold above this many bytes. */
export const MAX_COMPRESSION_THRESHOLD_BYTES = 1073741824

/** The middleware compresses with Brotli at this quality, on a scale from 0 to 11, where Brotli spends less CPU time at a lower quality. */
export const BROTLI_QUALITY = 4

/** The middleware takes the encodings that the client lists from this header. */
export const ACCEPT_ENCODING_HEADER = 'accept-encoding'

/** The middleware sends the encoding of the body in this header. */
export const CONTENT_ENCODING_HEADER = 'content-encoding'

/** The middleware adds `Accept-Encoding` to this header. */
export const VARY_HEADER = 'vary'

/** The middleware leaves a response unchanged when this header contains `no-transform`. */
export const CACHE_CONTROL_HEADER = 'cache-control'

/** The middleware weakens a strong validator in this header when it compresses the body. */
export const ETAG_HEADER = 'etag'

/** The middleware leaves a response with one of these statuses unchanged. */
export const UNCOMPRESSED_STATUSES: readonly number[] = [204, 206, 304]

/** The middleware compresses every `text/` type apart from these. */
export const UNCOMPRESSED_TEXT_TYPES: readonly string[] = ['text/event-stream']

/** The middleware compresses these types beyond `text/`, `+json`, and `+xml`. */
export const COMPRESSIBLE_TYPES: readonly string[] = [
  'application/json',
  'application/javascript',
  'application/xml',
  'application/x-javascript',
  'application/graphql',
  'image/svg+xml',
]

/** The middleware can compress with these encodings, and by default it picks from them in this order. */
export const DEFAULT_COMPRESSION_ENCODINGS: readonly string[] = ['br', 'zstd', 'gzip']
