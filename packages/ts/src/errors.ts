/**
 * Every {@link UhttpError} has one of these codes, so you can match on the code in an error
 * handler. Each code corresponds to one HTTP status.
 *
 * @remarks
 * `INVALID_PATH_PARAMETER`, `INVALID_JSON`, `VALIDATION_FAILED`, `INVALID_MULTIPART`,
 * `REQUEST_ABORTED`, `INVALID_TRANSFER_ENCODING`, and `INVALID_UPGRADE` correspond to 400,
 * `FORBIDDEN_ORIGIN` to 403, `NOT_FOUND` to 404, `METHOD_NOT_ALLOWED` to 405, `PAYLOAD_TOO_LARGE`
 * to 413, `UNSUPPORTED_MEDIA_TYPE` to 415, `UPGRADE_REQUIRED` to 426, `UNSUPPORTED_TRANSFER_CODING`
 * to 501, and `HANDLER_TIMEOUT` and `SERVER_CLOSING` to 503. Every other code corresponds to 500.
 * The package throws each code in one situation:
 *
 * - The package throws `INVALID_PATH_PARAMETER` when a path parameter contains a percent sequence
 *   that fails to decode.
 * - The package throws `NOT_FOUND` when a path has no route.
 * - The package throws `METHOD_NOT_ALLOWED` when a path has routes, but none for the method of the
 *   request.
 * - The package throws `PAYLOAD_TOO_LARGE` when a request body, a form, or an upload passes one of
 *   its limits, and it closes the connection after the reply.
 * - The package throws `UNSUPPORTED_MEDIA_TYPE` when a body parser receives a content type or a
 *   charset that it can't parse, or when the client compresses a request body.
 * - The package throws `INVALID_JSON` when `json()` can't parse a body, or when the body contains a
 *   `__proto__` key or a `constructor` key with a `prototype` key.
 * - The package throws `VALIDATION_FAILED` when a schema rejects a JSON body.
 * - The package throws `INVALID_MULTIPART` when a multipart body has an invalid boundary, a part
 *   without a name, a control character in a name or a filename, or no closing boundary.
 * - The package throws `REQUEST_ABORTED` from a read of the body when the client disconnects before
 *   the body ends.
 * - The package throws `HANDLER_TIMEOUT` when a handler passes the time limit of its route, and it
 *   closes the connection after the reply.
 * - The package sends `INVALID_TRANSFER_ENCODING` when a client lists `chunked` more than once in
 *   the `transfer-encoding` lines of a request, or ends those lines with a coding other than
 *   `chunked`.
 * - The package sends `UNSUPPORTED_TRANSFER_CODING` when a client applies a transfer coding before
 *   `chunked`, such as `gzip, chunked`, because the package decodes `chunked` alone.
 * - The package throws `UNDECLARED_HEADER` when your code asks for a header that neither the route
 *   nor its middleware declared.
 * - The package throws `UNDECLARED_CLIENT_ADDRESS` when your code asks for the client address and
 *   nobody declared it.
 * - The package throws `UNDECLARED_BODY` when your code reads the body on a route without a body
 *   reader.
 * - The package throws `BODY_ALREADY_READ` when your code reads a body after it streamed that body.
 * - The package throws `REQUEST_RELEASED` when your code reads the query string or the content type
 *   for the first time after the package has sent a reply that your handler returned without an
 *   `await`, because uWebSockets.js frees the request once its handler returns. Reading
 *   `header('content-type')`, `headers()`, or `body` also reads the content type.
 * - The package throws `INVALID_SCHEMA` when a schema lacks the Standard Schema interface, or when
 *   its validator throws, rejects, or returns something other than a Standard Schema result.
 * - The package throws `INVALID_UPLOAD` when you pass `multipart()` a limit that is not a whole
 *   number of zero or more, when its `file` callback returns something other than a writable
 *   stream, or when a destination closes before the package has written the whole file.
 * - The package throws `INVALID_HEADER` when your code sets a header name or a header value that
 *   HTTP forbids.
 * - The package throws `INVALID_EVENT` when a server-sent event has a line break in its name or its
 *   ID, or when its retry time is not a whole number of zero or more.
 * - The package throws `INVALID_STREAM` when your producer writes more or fewer bytes than the
 *   length that you declared, or when you pass a stream option outside its range.
 * - The package throws `MISSING_REPLY` when the middleware chain ends without a reply.
 * - The package throws `NEXT_CALLED_TWICE` when a middleware calls `next()` a second time.
 * - The package throws `INVALID_ROUTE` when you add a route path or a group prefix that the router
 *   can't match, a route option of the wrong type, or a WebSocket limit outside its range.
 * - The package throws `INVALID_STATUS` when you pass a helper a status that its reply can't have.
 * - The package throws `INVALID_APP_OPTIONS` when you pass {@link createApp} an option of the wrong
 *   type, or a limit that is not a whole number of zero or more.
 * - The package throws `INVALID_SERVE_OPTIONS` when you pass {@link serve} an option of the wrong
 *   type or a value outside its range, when you pass `threads` together with an app object or a
 *   Unix socket path, or when you call `server.reload()` on a server without `tls`.
 * - The package throws `LISTEN_FAILED` when the operating system can't bind the address that you
 *   chose, when the Unix socket path names a file other than a socket or a socket in use, or when
 *   the package can't set the mode of the socket file.
 * - The package throws `INVALID_CERTIFICATE` when {@link serve} or `server.reload()` can't read a
 *   key file or a certificate file, or when a key fails to decrypt with its passphrase or to match
 *   its certificate.
 * - The package sends `SERVER_CLOSING` when a request arrives on an open connection after
 *   `server.close()` has started, and it closes the connection after the reply. `server.reload()`
 *   throws it once `server.close()` has started.
 * - The package throws `UPGRADE_REQUIRED` when a client sends a request without a WebSocket upgrade
 *   to a WebSocket route, or asks for a version of the protocol other than 13.
 * - The package throws `INVALID_UPGRADE` when a client sends an upgrade request without
 *   `upgrade: websocket` or `connection: upgrade`, with a malformed `sec-websocket-key`, or with a
 *   body.
 * - The package throws `FORBIDDEN_ORIGIN` when a client sends an upgrade request from the `null`
 *   origin, or from an origin that fails the check of the route.
 * - The package throws `INVALID_WEBSOCKET` when your code passes a topic or a message of the wrong
 *   type to a socket or to `app.publish()`, or closes a socket with a code or a reason that
 *   RFC 6455 forbids.
 * - The package throws `APP_START_FAILED` when the module that you pass to {@link serve} throws
 *   while it builds the app, when its default export is neither an app nor a function that returns
 *   one, or when a worker thread crashes before every worker serves.
 *
 * The package sends `INVALID_TRANSFER_ENCODING` and `UNSUPPORTED_TRANSFER_CODING` before it calls
 * any middleware or handler, and it closes the connection after the reply. It sends
 * `SERVER_CLOSING` before it calls any middleware or handler too. When your code throws any error
 * apart from a `UhttpError` below 500, a `HANDLER_TIMEOUT`, or a `SERVER_CLOSING`, the client
 * receives `INTERNAL_ERROR`.
 */
export type ErrorCode =
  | 'INVALID_PATH_PARAMETER'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INVALID_JSON'
  | 'VALIDATION_FAILED'
  | 'INVALID_MULTIPART'
  | 'REQUEST_ABORTED'
  | 'HANDLER_TIMEOUT'
  | 'INVALID_TRANSFER_ENCODING'
  | 'UNSUPPORTED_TRANSFER_CODING'
  | 'INTERNAL_ERROR'
  | 'MISSING_REPLY'
  | 'NEXT_CALLED_TWICE'
  | 'UNDECLARED_HEADER'
  | 'UNDECLARED_CLIENT_ADDRESS'
  | 'UNDECLARED_BODY'
  | 'BODY_ALREADY_READ'
  | 'REQUEST_RELEASED'
  | 'INVALID_SCHEMA'
  | 'INVALID_UPLOAD'
  | 'INVALID_HEADER'
  | 'INVALID_EVENT'
  | 'INVALID_STREAM'
  | 'INVALID_ROUTE'
  | 'INVALID_STATUS'
  | 'INVALID_APP_OPTIONS'
  | 'INVALID_SERVE_OPTIONS'
  | 'LISTEN_FAILED'
  | 'UPGRADE_REQUIRED'
  | 'INVALID_UPGRADE'
  | 'FORBIDDEN_ORIGIN'
  | 'INVALID_WEBSOCKET'
  | 'APP_START_FAILED'
  | 'INVALID_CERTIFICATE'
  | 'SERVER_CLOSING'

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  INVALID_PATH_PARAMETER: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_JSON: 400,
  VALIDATION_FAILED: 400,
  INVALID_MULTIPART: 400,
  REQUEST_ABORTED: 400,
  HANDLER_TIMEOUT: 503,
  INVALID_TRANSFER_ENCODING: 400,
  UNSUPPORTED_TRANSFER_CODING: 501,
  INTERNAL_ERROR: 500,
  MISSING_REPLY: 500,
  NEXT_CALLED_TWICE: 500,
  UNDECLARED_HEADER: 500,
  UNDECLARED_CLIENT_ADDRESS: 500,
  UNDECLARED_BODY: 500,
  BODY_ALREADY_READ: 500,
  REQUEST_RELEASED: 500,
  INVALID_SCHEMA: 500,
  INVALID_UPLOAD: 500,
  INVALID_HEADER: 500,
  INVALID_EVENT: 500,
  INVALID_STREAM: 500,
  INVALID_ROUTE: 500,
  INVALID_STATUS: 500,
  INVALID_APP_OPTIONS: 500,
  INVALID_SERVE_OPTIONS: 500,
  LISTEN_FAILED: 500,
  UPGRADE_REQUIRED: 426,
  INVALID_UPGRADE: 400,
  FORBIDDEN_ORIGIN: 403,
  INVALID_WEBSOCKET: 500,
  APP_START_FAILED: 500,
  INVALID_CERTIFICATE: 500,
  SERVER_CLOSING: 503,
}

/**
 * The package lists each problem that a validator found with a body in this shape.
 */
export interface ValidationIssue {
  /** The validator wrote this message, which the package cuts to 256 characters. */
  readonly message: string
  /**
   * The validator reports this path from the root of the body to the value with the problem, such
   * as `['user', 'age']`, and the package keeps its first 16 segments.
   */
  readonly path: readonly (string | number)[]
}

/**
 * You can pass these options to the {@link UhttpError} constructor.
 */
export interface UhttpErrorOptions extends ErrorOptions {
  /** The package sends these problems under `issues` in the default error reply. */
  readonly issues?: readonly ValidationIssue[]
}

/**
 * The package throws a `UhttpError` with a code that you can match on and with the HTTP status
 * that corresponds to the code.
 *
 * @remarks
 * When code throws a `UhttpError` whose status is below 500, or one with the code `HANDLER_TIMEOUT`
 * or `SERVER_CLOSING`, the client receives that status together with the code, the message, and
 * any validation problems. For every other error, the client receives a 500 with the message 'The
 * request failed.'
 */
export class UhttpError extends Error {
  /** You can match on this code in an error handler. */
  readonly code: ErrorCode
  /** This HTTP status corresponds to the code. */
  readonly status: number
  /**
   * For a `VALIDATION_FAILED` error, the package puts the first problems that the validator found
   * here, while for any other error this is `undefined`.
   */
  readonly issues: readonly ValidationIssue[] | undefined

  /**
   * Creates an error with a code and a message.
   *
   * @param code - You choose the code, and the constructor sets the HTTP status that corresponds to it.
   * @param message - You write this message for a developer, and the package sends it to the
   * client only when the status is below 500 or the code is `HANDLER_TIMEOUT` or `SERVER_CLOSING`.
   * @param options - You can pass the standard error options here, such as `cause`, together with
   * a list of validation problems.
   */
  constructor(code: ErrorCode, message: string, options?: UhttpErrorOptions) {
    super(message, options)
    this.name = 'UhttpError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
    this.issues = options?.issues
  }
}

/**
 * Returns `true` when the package sends the code and the message of an error to the client, which
 * it does for a `UhttpError` below 500, for `HANDLER_TIMEOUT`, and for `SERVER_CLOSING`.
 *
 * @param error - The function checks this error.
 * @returns The function returns `false` for every other error, which the client receives as a 500.
 * @internal
 */
export function isClientError(error: unknown): error is UhttpError {
  return (
    error instanceof UhttpError &&
    (error.status < 500 || error.code === 'HANDLER_TIMEOUT' || error.code === 'SERVER_CLOSING')
  )
}
