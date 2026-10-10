/**
 * Every {@link UhttpError} has one of these codes, so you can match on the code in an error
 * handler. Each code corresponds to one HTTP status.
 *
 * @remarks
 * `NOT_FOUND` corresponds to 404, and every other code corresponds to 500. The package throws
 * `INVALID_ROUTE` when you add a route path that the router can't match, `INVALID_STATUS` when a
 * handler passes a status outside 200 to 599, `INVALID_SERVE_OPTIONS` when
 * you pass {@link serve} a port outside the TCP range, and `LISTEN_FAILED` when the operating
 * system can't bind the address that you chose. When a handler throws any error apart from a
 * `UhttpError` below 500, the client receives `INTERNAL_ERROR`.
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'INVALID_ROUTE'
  | 'INVALID_STATUS'
  | 'INVALID_SERVE_OPTIONS'
  | 'LISTEN_FAILED'

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  INVALID_ROUTE: 500,
  INVALID_STATUS: 500,
  INVALID_SERVE_OPTIONS: 500,
  LISTEN_FAILED: 500,
}

/**
 * The package throws a `UhttpError` with a code that you can match on and with the HTTP status
 * that corresponds to the code.
 *
 * @remarks
 * When a handler throws a `UhttpError` whose status is below 500, the client receives that status
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
   * @param code - You choose the code, and the constructor derives the HTTP status from it.
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
