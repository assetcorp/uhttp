import type { HttpResponse } from 'uWebSockets.js'
import { LINGERING_CLOSE_MS } from '../constants.js'
import type { Exchange } from '../exchange/index.js'

/**
 * Closes the connection of a request whose response has not ended, and records the close as a
 * disconnect. After the end of the response, the function does nothing.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @internal
 */
export function closeConnection(res: HttpResponse, exchange: Exchange): void {
  if (exchange.closed) return
  res.close()
  exchange.abort()
}

/**
 * Attaches the abort handler to a response that stays open after the handler of uWebSockets.js
 * returns, because uWebSockets.js requires one on such a response. The function also counts the
 * response in the drain of its app. The package attaches the handler only to a response that stays
 * open, and only once for each request.
 *
 * @param res - The package passes the response of uWebSockets.js, which is still open.
 * @param exchange - The package passes the state of the request, which the abort handler aborts.
 * @internal
 */
export function watchAbort(res: HttpResponse, exchange: Exchange): void {
  if (exchange.watchingAbort) return
  exchange.watchingAbort = true
  res.onAborted(() => exchange.abort())
  exchange.countOpenResponse()
}

/**
 * Calls a function once {@link LINGERING_CLOSE_MS} has passed, unless the connection closes first.
 *
 * @param exchange - The package passes the state of the request.
 * @param expire - The package passes the function that ends the wait, such as one that closes the connection.
 * @returns The function returns a function that stops the timer.
 * @internal
 */
export function lingerThen(exchange: Exchange, expire: () => void): () => void {
  const timer = setTimeout(() => {
    if (!exchange.disconnected) expire()
  }, LINGERING_CLOSE_MS)
  const stop = (): void => clearTimeout(timer)
  exchange.onDisconnect(stop)
  return stop
}

/**
 * Closes the connection after {@link LINGERING_CLOSE_MS} unless the connection closes first. The
 * caller keeps the response of uWebSockets.js open until then, because uWebSockets.js gives no way
 * to close a socket once its response has ended.
 *
 * @param res - The package passes the response of uWebSockets.js, which stays open.
 * @param exchange - The package passes the state of the request.
 * @internal
 */
export function closeAfterLingering(res: HttpResponse, exchange: Exchange): void {
  lingerThen(exchange, () => {
    res.close()
    exchange.abort()
  })
}

/**
 * Returns the address of the client as text, such as `127.0.0.1` or `::1`.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @returns The function returns the address that uWebSockets.js reports for the socket.
 * @internal
 */
export function remoteAddressOf(res: HttpResponse): string {
  return Buffer.from(res.getRemoteAddressAsText()).toString()
}
