import type { HttpResponse } from 'uWebSockets.js'
import { CLOSING_BODY_DRAIN_MS } from '../constants.js'
import type { Exchange } from '../exchange.js'

/**
 * Holds the end of a response while the request body is still arriving on a connection that closes
 * after the response. uWebSockets.js closes a socket as soon as such a response ends, and a close
 * with request bytes still unread makes the operating system reset the connection, which can
 * discard the response before the client reads it. The function calls `resume` once the last byte
 * of the body arrives, and it closes the connection without the response when the body takes
 * longer than 30 seconds.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request, which tracks the body.
 * @param resume - The package passes the function that ends the response, which this function calls inside a cork.
 * @returns The function returns `false` when the response can end at once, and it then never calls `resume`.
 * @internal
 */
export function holdForBody(res: HttpResponse, exchange: Exchange, resume: () => void): boolean {
  if (!exchange.holdsReplyForBody()) return false
  const timer = setTimeout(() => {
    if (exchange.closed) return
    res.close()
    exchange.abort()
  }, CLOSING_BODY_DRAIN_MS)
  exchange.onClose(() => clearTimeout(timer))
  exchange.onBodyEnd(() => {
    clearTimeout(timer)
    if (!exchange.closed) res.cork(resume)
  })
  return true
}
