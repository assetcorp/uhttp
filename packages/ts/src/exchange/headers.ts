import { settableHeaderName } from '../headers.js'
import type { PreparedHeader, PreparedName } from '../response.js'
import type { Exchange } from './state.js'

/**
 * Sets a response header after checking its name and its value. The package sends the header
 * with whatever reply the request ends with, unless the chain produced that reply later with a
 * header of the same name.
 *
 * @param exchange - The package passes the state of the request.
 * @param name - The package stores this header name in lowercase.
 * @param value - The package sends this value.
 * @param append - When this is `true`, the package keeps the earlier lines of the header.
 * @internal
 */
export function setHeader(exchange: Exchange, name: string, value: string, append: boolean): void {
  const lowerName = settableHeaderName(name, value)
  if (lowerName !== undefined) exchange.storeHeader(lowerName, value, undefined, append)
}

/**
 * Sets a response header that a middleware checked and encoded once at startup. The function
 * checks it no further.
 *
 * @param exchange - The package passes the state of the request.
 * @param header - The middleware passes the prepared header.
 * @param append - When this is `true`, the package keeps the earlier lines of the header.
 * @internal
 */
export function setFixed(exchange: Exchange, header: PreparedHeader, append: boolean): void {
  exchange.storeHeader(header.name, header.value, header.encoded, append)
}

/**
 * Sets a response header under a name that a middleware prepared at startup, with a value that
 * the middleware built and checked for this request. The function checks neither of them again.
 *
 * @param exchange - The package passes the state of the request.
 * @param name - The middleware passes the prepared name.
 * @param value - The middleware passes the checked value.
 * @param append - When this is `true`, the package keeps the earlier lines of the header.
 * @internal
 */
export function setPrepared(exchange: Exchange, name: PreparedName, value: string, append: boolean): void {
  exchange.storeHeader(name.name, value, name.encoded, append)
}
