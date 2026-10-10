/**
 * Every {@link UhttpError} has one of these codes, so you can match on the code in an error
 * handler. Each code corresponds to one HTTP status.
 *
 * @remarks
 * `INVALID_PATH_PARAMETER` corresponds to 400, `NOT_FOUND` to 404, and `METHOD_NOT_ALLOWED` to
 * 405. Every other code corresponds to 500. The package throws each code in one situation:
 *
 * - The package throws `INVALID_PATH_PARAMETER` when a path parameter contains a percent sequence
 *   that fails to decode.
 * - The package throws `NOT_FOUND` when a path has no route.
 * - The package throws `METHOD_NOT_ALLOWED` when a path has routes, but none for the method of the
 *   request.
 * - The package throws `UNDECLARED_HEADER` when your code asks for a header that neither the route
 *   nor its middleware declared.
 * - The package throws `UNDECLARED_CLIENT_ADDRESS` when your code asks for the client address and
 *   nobody declared it.
 * - The package throws `INVALID_HEADER` when your code sets a header name or a header value that
 *   HTTP forbids.
 * - The package throws `INVALID_EVENT` when a server-sent event has a line break in its name or its
 *   ID, or when its retry time is not a whole number of zero or more.
 * - The package throws `INVALID_STREAM` when your producer writes more or fewer bytes than the
 *   length that you declared, or when you pass a stream option outside its range.
 * - The package throws `MISSING_REPLY` when the middleware chain ends without a reply.
 * - The package throws `NEXT_CALLED_TWICE` when a middleware calls `next()` a second time.
 * - The package throws `INVALID_ROUTE` when you add a route path or a group prefix that the router
 *   can't match.
 * - The package throws `INVALID_STATUS` when you pass a helper a status that its reply can't have.
 * - The package throws `INVALID_APP_OPTIONS` when you pass {@link createApp} an option of the wrong
 *   type.
 * - The package throws `INVALID_SERVE_OPTIONS` when you pass {@link serve} a port outside the TCP
 *   range.
 * - The package throws `LISTEN_FAILED` when the operating system can't bind the address that you
 *   chose.
 *
 * When your code throws any error apart from a `UhttpError` below 500, the client receives
 * `INTERNAL_ERROR`.
 */
export type ErrorCode =
  | 'INVALID_PATH_PARAMETER'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL_ERROR'
  | 'MISSING_REPLY'
  | 'NEXT_CALLED_TWICE'
  | 'UNDECLARED_HEADER'
  | 'UNDECLARED_CLIENT_ADDRESS'
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
  INTERNAL_ERROR: 500,
  MISSING_REPLY: 500,
  NEXT_CALLED_TWICE: 500,
  UNDECLARED_HEADER: 500,
  UNDECLARED_CLIENT_ADDRESS: 500,
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
 * The package throws a `UhttpError` with a code that you can match on and with the HTTP status
 * that corresponds to the code.
 *
 * @remarks
 * When code throws a `UhttpError` whose status is below 500, the client receives that status
 * together with the code and the message. For every other error, the client receives a 500 with
 * the message 'The request failed.'
 */
export class UhttpError extends Error {
  /** You can match on this code in an error handler. */
  readonly code: ErrorCode
  /** This HTTP status corresponds to the code. */
  readonly status: number

  /**
   * Creates an error with a code and a message.
   *
   * @param code - You choose the code, and the constructor sets the HTTP status that corresponds to it.
   * @param message - You write this message for a developer, and the package sends it to the
   * client only when the status is below 500.
   * @param options - You can pass the standard error options here, such as `cause`.
   */
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UhttpError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
  }
}
