/** The middleware cuts each line of the access log to this many characters. */
export const ACCESS_LOG_LINE_LENGTH_LIMIT = 2048

/** The middleware writes this in place of a field without a value, such as the route of a 404. */
export const MISSING_FIELD = '-'

/** The middleware writes the duration of a request with this many digits after the point. */
export const DURATION_FRACTION_DIGITS = 1

/** The middleware writes this message to the logger when the write function of the access log throws. */
export const FAILED_WRITE_MESSAGE =
  'The write function of accessLog() threw, so the package dropped one line of the access log.'
