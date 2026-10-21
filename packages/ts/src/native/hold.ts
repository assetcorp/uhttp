import type { HttpResponse } from 'uWebSockets.js'
import { closesBeforeBodyEnds, type Exchange } from '../exchange/index.js'
import { lingerThen } from './close.js'

/**
 * Holds the end of a response while the request body is still arriving on a connection that closes
 * after the response. uWebSockets.js closes the socket as soon as such a response ends. When unread
 * request bytes remain in the socket at that close, the operating system resets the connection,
 * which can discard the response before the client reads it. The function calls `resume` once the
 * last byte of the body arrives, and it calls `giveUp` when {@link lingerThen} stops waiting for
 * that byte.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request, which follows the arrival of the body.
 * @param resume - The package passes the function that ends the response, which this function calls inside a cork.
 * @param giveUp - The package passes the function that this function calls once the wait ends without the body.
 * @returns The function returns `false` when the response can end at once, and it then never calls `resume`.
 * @internal
 */
export function holdForBody(res: HttpResponse, exchange: Exchange, resume: () => void, giveUp: () => void): boolean {
  if (!closesBeforeBodyEnds(exchange)) return false
  const stop = lingerThen(exchange, () => {
    if (!exchange.closed) giveUp()
  })
  exchange.onClose(stop)
  exchange.arrival.onEnd(() => {
    stop()
    if (!exchange.closed) res.cork(resume)
  })
  return true
}
