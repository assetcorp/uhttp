/** The middleware asks the browser to cache the result of a preflight request for this many seconds by default. */
export const DEFAULT_CORS_MAX_AGE_SECONDS = 600

/** The middleware throws for a `maxAge` above this many seconds, which is one day. */
export const MAX_CORS_MAX_AGE_SECONDS = 86400

/** The middleware allows these methods in reply to a preflight request by default. */
export const DEFAULT_CORS_METHODS: readonly string[] = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH']

/** The middleware echoes an `Access-Control-Request-Headers` list of at most this many characters. */
export const ECHOED_REQUEST_HEADERS_LENGTH_LIMIT = 1024

/** The middleware takes the origin of the request from this header. */
export const ORIGIN_HEADER = 'origin'

/** In a preflight request, the browser sends the method of the real request in this header. */
export const REQUEST_METHOD_HEADER = 'access-control-request-method'

/** In a preflight request, the browser lists the headers of the real request in this header. */
export const REQUEST_HEADERS_HEADER = 'access-control-request-headers'

/** The middleware sends the allowed origin in this header. */
export const ALLOW_ORIGIN_HEADER = 'access-control-allow-origin'

/** The middleware sends `true` in this header when you allow credentials. */
export const ALLOW_CREDENTIALS_HEADER = 'access-control-allow-credentials'

/** The middleware lists the allowed methods in this header in reply to a preflight request. */
export const ALLOW_METHODS_HEADER = 'access-control-allow-methods'

/** The middleware lists the allowed request headers in this header in reply to a preflight request. */
export const ALLOW_HEADERS_HEADER = 'access-control-allow-headers'

/** The middleware lists the response headers that a script may read in this header. */
export const EXPOSE_HEADERS_HEADER = 'access-control-expose-headers'

/** The middleware sends the cache lifetime of the result of a preflight request in this header. */
export const MAX_AGE_HEADER = 'access-control-max-age'

/** The middleware lists the request headers on which its reply depends in this header. */
export const VARY_HEADER = 'vary'

/** The middleware sends this status in reply to a preflight request. */
export const PREFLIGHT_STATUS = 204
