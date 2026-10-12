/** {@link serve} throws for a port below 0, and with port 0 the operating system assigns a free port. */
export const MIN_PORT = 0

/** {@link serve} throws for a port above 65535, which is the highest TCP port. */
export const MAX_PORT = 65_535

/** A reply can have a status from 200 upwards, because a 1xx status can only precede a final response. */
export const MIN_REPLY_STATUS = 200

/** A reply can have a status up to 599, which is the top of the 5xx range. */
export const MAX_REPLY_STATUS = 599

/** Under RFC 9110, a response with one of these statuses has no content, so the package sends it without a body. */
export const BODYLESS_STATUSES: readonly number[] = [204, 205, 304]

/** A redirect can have one of these statuses, and for each of them the client follows the `location` header. */
export const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308]

/** When you leave out the status of a redirect, the package sends 302. */
export const DEFAULT_REDIRECT_STATUS = 302

/** For an OPTIONS request to a path that has routes, the package sends this status with no body. */
export const OPTIONS_STATUS = 204

/** The package writes the methods of a path into the `Allow` header in this order. */
export const ALLOW_METHOD_ORDER: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

/**
 * uWebSockets.js matches no more than the first 100 segments of a path. The package therefore
 * throws for a route path or a group prefix with more segments than this, so that both matchers
 * return the same result for every path.
 */
export const MAX_ROUTE_SEGMENTS = 99

/**
 * uWebSockets.js v20.71.0 sends a 400 for a request with more header lines than this, and
 * `app.request()` returns the same 400.
 */
export const MAX_REQUEST_HEADER_COUNT = 98

/**
 * uWebSockets.js sends a 400 for a request whose request line and headers take more bytes than
 * this, unless the host sets `UWS_HTTP_MAX_HEADERS_SIZE` before uWebSockets.js loads.
 * `app.request()` follows the same setting.
 */
export const DEFAULT_MAX_REQUEST_HEAD_BYTES = 4096

/**
 * uWebSockets.js v20.71.0 sends a 400 for a `content-length` value with more characters than
 * this, and the package checks the same rule before it calls any handler.
 */
export const LONGEST_CONTENT_LENGTH_DIGITS = 18

/**
 * uWebSockets.js v20.71.0 closes the connection after the response when the `connection` header of
 * the request has this many characters, as `close` does, and the package applies the same rule.
 */
export const CONNECTION_CLOSE_VALUE_LENGTH = 5

/** When a test sets no `Host` header, `app.request()` sends this one, as `fetch` does. */
export const TEST_REQUEST_HOST = 'localhost'

/** When a test sets no client address, a handler reads this address from a request that `app.request()` sends. */
export const TEST_CLIENT_ADDRESS = '127.0.0.1'

/**
 * The package collects every line of these request headers, because a client can send each of
 * them more than once. For any other header, the package copies the first line alone.
 */
export const LIST_HEADER_NAMES: readonly string[] = [
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'pragma',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]

/** The package joins the lines of a list header with this separator, apart from `cookie`. */
export const LIST_HEADER_SEPARATOR = ', '

/** The package joins the lines of a `cookie` header with this separator, as section 8.2.3 of RFC 9113 requires. */
export const COOKIE_HEADER_SEPARATOR = '; '

/** The package alone sets the framing of a response, so it drops these headers when code sets them. */
export const FRAMING_HEADER_NAMES: readonly string[] = ['content-length', 'transfer-encoding', 'connection', 'date']

/**
 * The server-sent events helper sends a heartbeat comment at this interval in milliseconds by
 * default. nginx closes a proxied connection after 60 seconds without data under its default
 * `proxy_read_timeout`, and an AWS Application Load Balancer closes an idle connection after 60
 * seconds under its default idle timeout.
 */
export const DEFAULT_SSE_HEARTBEAT_MS = 30_000

/** The server-sent events helper sends this comment as its heartbeat. */
export const SSE_HEARTBEAT_COMMENT = ':\n\n'

/** When neither the app nor the route sets `maxBodyBytes`, the package accepts a request body of up to 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576

/** The package attaches a body reader on routes of these methods unless the route sets `body: false`. */
export const BODY_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH']

/**
 * The package pauses the socket once it holds this many bytes of the body that your code hasn't
 * read, so that it holds no more than this figure and one more chunk in memory for a slow reader.
 */
export const BODY_HIGH_WATER_MARK_BYTES = 65_536

/**
 * uWebSockets.js clears its 10-second idle timer while the package keeps a socket paused, so the
 * package closes the connection itself once the socket stays paused for this many milliseconds.
 */
export const BODY_PAUSE_TIMEOUT_MS = 10_000

/**
 * When more of the request body than this is still on its way after the reply, the package closes
 * the connection, because reading the rest would cost more than a new connection. A chunked body of
 * unknown length counts as more. Go's HTTP server applies the same 256 KiB limit to the part of a
 * body that a handler leaves unread.
 */
export const DISCARDABLE_BODY_BYTES = 262_144

/**
 * When the package closes a connection while the request body is still arriving, it keeps reading
 * and discarding the body for up to this many milliseconds, so that the client can read the reply
 * before the close. The figure matches the default `lingering_time` of nginx.
 */
export const LINGERING_CLOSE_MS = 30_000

/** When neither the app nor the route sets `timeoutMs`, a handler has no time limit, since 0 means no limit. */
export const DEFAULT_TIMEOUT_MS = 0

/** Node sets a `setTimeout` delay above this many milliseconds to 1 millisecond, so the package throws for a longer time limit. */
export const MAX_TIMEOUT_MS = 2_147_483_647

/** `form()` throws once a URL-encoded body has more parameters than this. */
export const MAX_FORM_FIELDS = 1_000

/** The package sends no more than this many problems in the reply to a body that a schema rejects. */
export const VALIDATION_ISSUE_COUNT = 10

/** The package cuts the message of each validation problem to this many characters. */
export const VALIDATION_MESSAGE_LENGTH = 256

/** The package keeps no more than this many segments of the path of each validation problem. */
export const VALIDATION_PATH_SEGMENTS = 16

/** When you leave out `maxParts`, `multipart()` throws once a body has more parts than this. */
export const DEFAULT_MAX_MULTIPART_PARTS = 1_000

/** When you leave out `maxFieldBytes`, `multipart()` throws for a field value longer than this. */
export const DEFAULT_MAX_MULTIPART_FIELD_BYTES = 1_048_576

/** `multipart()` throws for a boundary longer than this, because RFC 2046 allows 1 to 70 characters. */
export const MAX_MULTIPART_BOUNDARY_LENGTH = 70

/** RFC 2046 allows these characters in a multipart boundary, and a space too, apart from at its end. */
export const MULTIPART_BOUNDARY_CHARACTERS = "0-9A-Za-z'()+_,\\-./:=?"

/** `multipart()` throws once the headers of one part take more bytes than this, which is busboy's limit too. */
export const MAX_PART_HEADER_BYTES = 16_384

/** `multipart()` throws for a part with more header lines than this. */
export const MAX_PART_HEADER_COUNT = 16

/** `multipart()` throws for a field name longer than this many bytes. */
export const MAX_PART_NAME_BYTES = 256

/** The package writes the reason phrase from this table after each standard status code from 200 to 511. */
export const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required',
}
