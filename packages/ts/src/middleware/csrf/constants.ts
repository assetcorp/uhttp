/** The middleware takes the fetch metadata of the browser from this header. */
export const FETCH_SITE_HEADER = 'sec-fetch-site'

/** The middleware compares this header with the allowed origins when the browser sends no fetch metadata. */
export const ORIGIN_HEADER = 'origin'

/** The middleware takes the content type of the request from this header. */
export const CONTENT_TYPE_HEADER = 'content-type'

/** The middleware takes the host of the request from this header when no trusted proxy reports one. */
export const HOST_HEADER = 'host'

/** The middleware allows these values of `Sec-Fetch-Site` without further checks. */
export const ALLOWED_FETCH_SITES: readonly string[] = ['same-origin', 'none']

/** The middleware lets these methods through, because RFC 9110 defines them as safe, so an app should change no state on them. */
export const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE']

/** A browser can send these content types from a form or a simple request without a preflight. */
export const FORM_CONTENT_TYPES: readonly string[] = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]

/** The middleware strips this port from the host of an `http` request before it compares origins. */
export const HTTP_PORT_SUFFIX = ':80'

/** The middleware strips this port from the host of an `https` request before it compares origins. */
export const HTTPS_PORT_SUFFIX = ':443'
