/** The middleware takes the inbound request ID from this header and sends the ID back in it. */
export const REQUEST_ID_HEADER = 'x-request-id'

/** The middleware keeps an inbound request ID of at most this many characters. */
export const REQUEST_ID_LENGTH_LIMIT = 255

/** The middleware keeps an inbound request ID only when it consists of these characters. */
export const REQUEST_ID_CHARACTERS = 'A-Za-z0-9_=-'
