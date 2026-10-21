import type { Exchange } from './state.js'

/**
 * Returns `true` when the package closes the connection after the response for a reason of its
 * own, in which case the reply contains `Connection: close`. The reason is an early rejection, a
 * `PAYLOAD_TOO_LARGE` error, a time limit, a rejected `transfer-encoding`, an unread rest of the
 * body that is longer than the package discards to keep the connection open, or a server that is
 * closing or reloading.
 *
 * @param exchange - The package passes the state of the request.
 * @returns The function returns `false` when only the client can ask for the close.
 * @internal
 */
export function serverCloses(exchange: Exchange): boolean {
  return exchange.closeAfterReply || exchange.startedArrival?.unbounded === true || !exchange.serving
}

/**
 * Returns `true` when the connection closes after the response, because the client or the
 * package asked for the close.
 *
 * @param exchange - The package passes the state of the request.
 * @returns The function returns `false` when the connection can serve another request.
 * @internal
 */
export function closesConnection(exchange: Exchange): boolean {
  return exchange.clientCloses || serverCloses(exchange)
}

/**
 * Returns `true` when the package closes the connection after the response while more of the
 * body is on its way, which means that the package has to keep reading the body after the reply.
 *
 * @param exchange - The package passes the state of the request.
 * @returns The function returns `false` when the response can end in the usual way.
 * @internal
 */
export function closesBeforeBodyEnds(exchange: Exchange): boolean {
  return exchange.startedArrival?.arriving === true && closesConnection(exchange)
}

/**
 * Returns `true` when the package sends the reply with `Connection: close` and closes the
 * connection itself later. It does so when it closes while more of the body is on its way, and
 * when it closes after a reply without a length, which uWebSockets.js can't end with a close.
 *
 * @param exchange - The package passes the state of the request.
 * @param lengthless - The caller passes `true` for a reply that carries neither a body nor a length.
 * @returns The function returns `false` when the reply can end with or without a close in the usual way.
 * @internal
 */
export function lingersAfterReply(exchange: Exchange, lengthless: boolean): boolean {
  return closesBeforeBodyEnds(exchange) || (lengthless && serverCloses(exchange))
}
