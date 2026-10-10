import type { HttpResponse } from 'uWebSockets.js'
import type { Exchange } from '../exchange.js'
import { closeConnection, remoteAddressOf } from './close.js'

const refusedConnections = new Set<string>()

function connectionKey(res: HttpResponse): string {
  return `${remoteAddressOf(res)}:${res.getRemotePort()}`
}

/**
 * Marks the connection of a request whose framing the package rejects, so that the package refuses
 * every later request that uWebSockets.js parses on that connection. When the body of the rejected
 * request ends in the same pass of the parser as a request that the client pipelines behind it,
 * uWebSockets.js drops the close of the connection and calls the handler of that request, so
 * without the mark the package can serve the hidden request. The package removes the mark one turn
 * of the event loop after the response ends, once that pass of the parser has finished.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @param exchange - The package passes the state of the rejected request.
 * @internal
 */
export function refuseLaterRequests(res: HttpResponse, exchange: Exchange): void {
  const key = connectionKey(res)
  refusedConnections.add(key)
  exchange.onClose(() => {
    setImmediate(() => refusedConnections.delete(key))
  })
}

/**
 * Refuses a request that arrives on a connection that {@link refuseLaterRequests} marked. The
 * function starts no chain, and it closes the connection one turn of the event loop later, once
 * uWebSockets.js has sent the rejection of the earlier request.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @param exchange - The package passes the state of the request.
 * @returns The function returns `true` when it refused the request.
 * @internal
 */
export function refusedRequest(res: HttpResponse, exchange: Exchange): boolean {
  if (refusedConnections.size === 0 || !refusedConnections.has(connectionKey(res))) return false
  setImmediate(() => closeConnection(res, exchange))
  return true
}
