/**
 * Every {@link UhttpError} has one of these codes, so you can match on the code in an error
 * handler. Each code corresponds to one HTTP status.
 *
 * @remarks
 * `INVALID_PATH_PARAMETER`, `INVALID_JSON`, `VALIDATION_FAILED`, `INVALID_MULTIPART`, and
 * `REQUEST_ABORTED` correspond to 400, `NOT_FOUND` to 404, `METHOD_NOT_ALLOWED` to 405,
 * `PAYLOAD_TOO_LARGE` to 413, `UNSUPPORTED_MEDIA_TYPE` to 415, and `HANDLER_TIMEOUT` to 503. Every
 * other code corresponds to 500. The package throws each code in one situation:
 *
 * - The package throws `INVALID_PATH_PARAMETER` when a path parameter contains a percent sequence
 *   that fails to decode.
 * - The package throws `NOT_FOUND` when a path has no route.
 * - The package throws `METHOD_NOT_ALLOWED` when a path has routes, but none for the method of the
 *   request.
 * - The package throws `PAYLOAD_TOO_LARGE` when a request body, a form, or an upload passes one of
 *   its limits.
 * - The package throws `UNSUPPORTED_MEDIA_TYPE` when a body parser meets a content type or a charset
 *   that it can't parse, or when a request body is compressed.
 * - The package throws `INVALID_JSON` when a JSON body fails to parse or contains a `__proto__` key
 *   or a `constructor` key with a `prototype` key.
 * - The package throws `VALIDATION_FAILED` when a JSON body fails its schema.
 * - The package throws `INVALID_MULTIPART` when a multipart body breaks the rules of RFC 7578.
 * - The package throws `REQUEST_ABORTED` from a body read when the client goes before the body ends.
 * - The package throws `HANDLER_TIMEOUT` when a handler passes the time limit of its route.
 * - The package throws `UNDECLARED_HEADER` when your code asks for a header that neither the route
 *   nor its middleware declared.
 * - The package throws `UNDECLARED_CLIENT_ADDRESS` when your code asks for the client address and
 *   nobody declared it.
 * - The package throws `UNDECLARED_BODY` when your code reads the body on a route without a body
 *   reader.
 * - The package throws `BODY_ALREADY_READ` when your code reads a body after it streamed that body.
 * - The package throws `INVALID_SCHEMA` when a schema lacks the Standard Schema interface, or when
 *   its validator throws or returns something else.
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
 *   can't match, or a route option of the wrong type.
 * - The package throws `INVALID_STATUS` when you pass a helper a status that its reply can't have.
 * - The package throws `INVALID_APP_OPTIONS` when you pass {@link createApp} an option of the wrong
 *   type.
 * - The package throws `INVALID_SERVE_OPTIONS` when you pass {@link serve} a port outside the TCP
 *   range.
 * - The package throws `LISTEN_FAILED` when the operating system can't bind the address that you
 *   chose.
 *
 * When your code throws any error apart from a `UhttpError` below 500 or a `HANDLER_TIMEOUT`, the
 * client receives `INTERNAL_ERROR`.
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
  | 'INTERNAL_ERROR'
  | 'MISSING_REPLY'
  | 'NEXT_CALLED_TWICE'
  | 'UNDECLARED_HEADER'
  | 'UNDECLARED_CLIENT_ADDRESS'
  | 'UNDECLARED_BODY'
  | 'BODY_ALREADY_READ'
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
  INTERNAL_ERROR: 500,
  MISSING_REPLY: 500,
  NEXT_CALLED_TWICE: 500,
  UNDECLARED_HEADER: 500,
  UNDECLARED_CLIENT_ADDRESS: 500,
  UNDECLARED_BODY: 500,
  BODY_ALREADY_READ: 500,
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
}

/**
 * The package lists each problem that a validator found with a body in this shape.
 */
export interface ValidationIssue {
  /** The validator wrote this message, which the package cuts to 256 characters. */
  readonly message: string
  /** The validator reports this path from the root of the body to the value with the problem, such as `['user', 'age']`. */
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
 * When code throws a `UhttpError` whose status is below 500, or one with the code
 * `HANDLER_TIMEOUT`, the client receives that status together with the code, the message, and any
 * validation problems. For every other error, the client receives a 500 with the message 'The
 * request failed.'
 */
export class UhttpError extends Error {
  /** You can match on this code in an error handler. */
  readonly code: ErrorCode
  /** This HTTP status corresponds to the code. */
  readonly status: number
  /** For a `VALIDATION_FAILED` error, the package puts the first problems that the validator found here, and for any other error this is `undefined`. */
  readonly issues: readonly ValidationIssue[] | undefined

  /**
   * Creates an error with a code and a message.
   *
   * @param code - You choose the code, and the constructor sets the HTTP status that corresponds to it.
   * @param message - You write this message for a developer, and the package sends it to the
   * client only when the status is below 500 or the code is `HANDLER_TIMEOUT`.
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
 * it does for a `UhttpError` below 500 and for `HANDLER_TIMEOUT`.
 *
 * @param error - The function checks this error.
 * @returns The function returns `false` for every other error, which the client receives as a 500.
 * @internal
 */
export function isClientError(error: unknown): error is UhttpError {
  return error instanceof UhttpError && (error.status < 500 || error.code === 'HANDLER_TIMEOUT')
}
