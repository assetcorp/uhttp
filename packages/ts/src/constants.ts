/** {@link serve} throws for a port below 0, and with port 0 the operating system assigns a free port. */
export const MIN_PORT = 0

/** {@link serve} throws for a port above 65535, which is the highest TCP port. */
export const MAX_PORT = 65_535

/** Before it binds a Unix socket, the package tries to connect to a socket already at the path for this many milliseconds, so that it removes only a socket on which no server answers. */
export const UNIX_SOCKET_PROBE_MS = 1_000

/** uWebSockets.js binds a port with this option so that the operating system refuses a second server on it, which is what {@link serve} does unless you set `reusePort`. */
export const LISTEN_EXCLUSIVE_PORT = 1

/** uWebSockets.js binds a port with this option so that the operating system lets every server that sets `reusePort` share it. */
export const LISTEN_SHARED_PORT = 0

/** By default, the package sets the mode of a Unix socket file to this one, so that only the user who owns the process can connect. */
export const DEFAULT_SOCKET_MODE = 0o600

/** {@link serve} throws for a socket mode above this one, which grants every permission to every user. */
export const MAX_SOCKET_MODE = 0o777

/** By default, `server.close()` waits this many milliseconds for the requests in progress and the WebSockets before it closes the connections that are left. */
export const DEFAULT_GRACE_PERIOD_MS = 10_000

/** {@link serve} throws for a grace period longer than this many milliseconds, which is the longest delay that `setTimeout` accepts. */
export const MAX_GRACE_PERIOD_MS = 2_147_483_647

/** Node.js fires a timer after 1 millisecond when its delay is longer than this many milliseconds, so the package caps the delay of every grace timer here. */
export const LONGEST_TIMER_DELAY_MS = 2_147_483_647

/** A hostname under `tls.hostnames` can have at most this many characters, which is the limit of RFC 1035. */
export const MAX_HOSTNAME_LENGTH = 253

/** A hostname under `tls.hostnames` can have at most this many labels, because uWebSockets.js finds no certificate for a hostname with more. */
export const MAX_HOSTNAME_LABELS = 10

/** A reply can have a status from 200 upwards, because a 1xx status can only precede a final response. */
export const MIN_REPLY_STATUS = 200

/** A reply can have a status up to 599, which is the top of the 5xx range. */
export const MAX_REPLY_STATUS = 599

/** The package answers an accepted WebSocket upgrade with this status. */
export const SWITCHING_PROTOCOLS_STATUS = 101

/** The main thread answers with this status while no worker thread serves. */
export const SERVICE_UNAVAILABLE_STATUS = 503

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

/**
 * uWebSockets.js treats a GET request as a WebSocket upgrade when its `sec-websocket-key` header
 * has this many characters, which is the length of 16 bytes in base64.
 */
export const WEBSOCKET_KEY_LENGTH = 24

/** Under RFC 6455, a client asks for this version of the WebSocket protocol, which is the only version that the package supports. */
export const WEBSOCKET_VERSION = '13'

/** RFC 6455 appends this text to the key of the client before it hashes the key into `sec-websocket-accept`. */
export const WEBSOCKET_ACCEPT_SUFFIX = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** uWebSockets.js writes these headers of a 101 itself, so the package leaves out a header of the same name that your code set. */
export const UPGRADE_REPLY_HEADER_NAMES: readonly string[] = [
  'upgrade',
  'sec-websocket-accept',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]

/** When a route leaves out `maxMessageBytes`, uWebSockets.js drops the connection of a client that sends a message longer than this many bytes, as it does by default. */
export const DEFAULT_WEBSOCKET_MAX_MESSAGE_BYTES = 16_384

/** When a route leaves out `maxBackpressureBytes`, uWebSockets.js drops each message to a socket with more than this many bytes in its buffer, as it does by default. */
export const DEFAULT_WEBSOCKET_MAX_BACKPRESSURE_BYTES = 65_536

/** uWebSockets.js turns off its backpressure limit at 0, so the package throws for a smaller limit, because the buffer of a slow client can then grow without a limit. */
export const MIN_WEBSOCKET_BACKPRESSURE_BYTES = 1

/** uWebSockets.js converts each WebSocket size limit to a signed 32-bit number, so the package throws for a larger limit. */
export const MAX_WEBSOCKET_LIMIT_BYTES = 2_147_483_647

/** When a route leaves out `idleTimeoutMs`, uWebSockets.js closes a WebSocket after this many milliseconds without a message, as it does by default. */
export const DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS = 120_000

/** uWebSockets.js aborts the process for a shorter idle time, so the package throws for one when you add the route. */
export const MIN_WEBSOCKET_IDLE_TIMEOUT_MS = 8_000

/** uWebSockets.js aborts the process for a longer idle time, so the package throws for one when you add the route. */
export const MAX_WEBSOCKET_IDLE_TIMEOUT_MS = 960_000

/** When a route leaves out `maxLifetimeMs`, the package sets no limit on the lifetime of a WebSocket, which uWebSockets.js expresses as 0. */
export const DEFAULT_WEBSOCKET_MAX_LIFETIME_MS = 0

/**
 * uWebSockets.js aborts the process for a lifetime above 240 minutes, and its binding lowers 240
 * minutes to 239, so the package throws for any lifetime above 239 minutes.
 */
export const MAX_WEBSOCKET_LIFETIME_MS = 14_340_000

/** uWebSockets.js counts the idle time of a WebSocket in whole seconds, so the package rounds an idle time up to the next second. */
export const MILLISECONDS_PER_SECOND = 1_000

/** uWebSockets.js counts the lifetime of a WebSocket in whole minutes, so the package rounds a lifetime up to the next minute. */
export const MILLISECONDS_PER_MINUTE = 60_000

/** RFC 6455 allows a close reason of at most this many bytes, because the payload of a control frame is at most 125 bytes and the code takes 2 of them. */
export const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123

/** `end()` accepts a code from this list, which RFC 6455 and the IANA registry define for an endpoint to send. */
export const WEBSOCKET_CLOSE_CODES: readonly number[] = [
  1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014,
]

/** `end()` also accepts any code from this one up to {@link MAX_APPLICATION_CLOSE_CODE}, since RFC 6455 reserves 3000 to 3999 for libraries, frameworks, and applications, and 4000 to 4999 for private use. */
export const MIN_APPLICATION_CLOSE_CODE = 3_000

/** `end()` accepts any code up to this one from {@link MIN_APPLICATION_CLOSE_CODE}. */
export const MAX_APPLICATION_CLOSE_CODE = 4_999

/** `end()` closes a WebSocket with this code, which RFC 6455 defines for a normal closure, when your code passes none. */
export const WEBSOCKET_NORMAL_CLOSE_CODE = 1000

/** The package closes a WebSocket with this code when one of its handlers throws or rejects. */
export const WEBSOCKET_HANDLER_ERROR_CODE = 1011

/** The package closes every WebSocket with this code when the server closes or reloads, since RFC 6455 defines it for an endpoint that goes away. */
export const WEBSOCKET_GOING_AWAY_CODE = 1001

/** The package sends this reason with {@link WEBSOCKET_GOING_AWAY_CODE}. */
export const WEBSOCKET_GOING_AWAY_REASON = 'The server is going away.'

/** The package writes this version byte at the start of every message that it passes to a pub/sub adapter. */
export const PUBSUB_ENVELOPE_VERSION = 1

/** Each message to a pub/sub adapter starts with the version, the flags, and this many bytes that identify the process that published it. */
export const PUBSUB_ORIGIN_BYTES = 16

/** The flags byte of a message to a pub/sub adapter has this bit set when the message is binary. */
export const PUBSUB_BINARY_FLAG = 1

/** The flags byte of a message to a pub/sub adapter has this bit set when the code that published the message asked for compression. */
export const PUBSUB_COMPRESS_FLAG = 2

/** By default, `serve()` serves every request on the main thread. */
export const DEFAULT_THREADS = 0

/** `serve()` throws for more worker threads than this, so that a mistyped count can't start thousands of threads, each with its own heap. */
export const MAX_THREADS = 1_024

/** The main thread starts the first replacement for a crashed worker after this many milliseconds. */
export const FIRST_RESTART_DELAY_MS = 1_000

/** The main thread doubles the delay before each replacement for a worker that keeps crashing, up to this many milliseconds. */
export const MAX_RESTART_DELAY_MS = 60_000

/** The main thread multiplies the delay before the next replacement by this factor after each replacement that it starts. */
export const RESTART_DELAY_GROWTH_FACTOR = 2

/** `serve()` throws for a heap limit below this many megabytes for each worker. */
export const MIN_WORKER_HEAP_MB = 1

/** `serve()` throws for a crash limit below this one. */
export const MIN_CRASH_LIMIT = 1

/** `serve()` throws for a crash window shorter than this many milliseconds. */
export const MIN_CRASH_WINDOW_MS = 1

/** `serve()` throws for a crash window longer than this many milliseconds, which is the longest delay that `setTimeout` accepts. */
export const MAX_CRASH_WINDOW_MS = 2_147_483_647

/** `serve()` throws for a watchdog timeout longer than this many milliseconds, which is the longest delay that `setTimeout` accepts. */
export const MAX_WATCHDOG_MS = 2_147_483_647

/** A worker exits with this code after it posts an error to the main thread, such as an error that no code caught or a failure to build the app. */
export const WORKER_FAILURE_EXIT_CODE = 1

/** A worker sends the main thread at most this many nested causes of an error, so that the worker stops at a cycle of causes. */
export const MAX_ERROR_CAUSE_DEPTH = 8

/**
 * The main thread resets the delay before the next replacement to {@link FIRST_RESTART_DELAY_MS}
 * once a worker has served for this many milliseconds without a crash, as PM2 does.
 */
export const RESTART_DELAY_RESET_MS = 30_000

/** By default, the server exits with an error once workers crash this many times within {@link DEFAULT_CRASH_WINDOW_MS}, which is the default start limit of systemd. */
export const DEFAULT_CRASH_LIMIT = 5

/** By default, the server counts worker crashes within a window of this many milliseconds, which is the default start limit interval of systemd. */
export const DEFAULT_CRASH_WINDOW_MS = 10_000

/** By default, the server exits with an error when a serving worker fails to answer the main thread for this many milliseconds, which is the default worker timeout of Gunicorn. */
export const DEFAULT_WATCHDOG_MS = 30_000

/** The main thread pings each serving worker this many times within the watchdog timeout. */
export const WATCHDOG_PINGS_PER_TIMEOUT = 6

/** The server exits with this code when no worker is left, when workers reach the crash limit, or when a worker hangs. */
export const FATAL_EXIT_CODE = 1

/** When the server closes, the main thread waits up to this many milliseconds past the grace period for every worker to exit, so that a worker that hangs during the close can't hold the close up forever. */
export const WORKER_EXIT_WAIT_MS = 5_000

/** When your code calls `process.exit()`, the exit hook of {@link serve} waits up to this many milliseconds in total for the workers to close their connections. */
export const EXIT_HOOK_WAIT_MS = 5_000

/** The package writes the reason phrase from this table after each standard status code from 101 to 511. */
export const STATUS_TEXT: Readonly<Record<number, string>> = {
  101: 'Switching Protocols',
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
