import type { Exchange } from '../exchange.js'
import { type RequestChain, rejectedChain } from '../resolve.js'
import { type BodyFraming, BodyReader, type BodySource, declaresNoBody, earlyRejection } from './reader.js'

/**
 * The package prepares the body of a request in this form, for uWebSockets.js and for
 * `app.request()` alike.
 *
 * @internal
 */
export interface OpenedBody {
  /** The handler reads the body through this reader, which is `undefined` on a route without one. */
  readonly reader: BodyReader | undefined
  /** The package sends the request through this chain, whose handler throws an early rejection. */
  readonly chain: RequestChain
  /** This is `true` when the source has to deliver the chunks of the body to the reader. */
  readonly flowing: boolean
}

/**
 * Prepares the body of a request after the copy of the request. On a route without a body reader,
 * the function changes nothing. For a compressed body or a declared length above the limit of the
 * route, it fails the reader with the early rejection, replaces the handler with one that throws
 * it, and marks the connection for closing, because the client has already been invited to send
 * the body.
 *
 * @param exchange - The package passes the state of the request.
 * @param chain - The package passes the chain of the request, with the limits of the route.
 * @param framing - The package passes the framing headers of the request.
 * @param source - The package passes the source that the reader pauses, resumes, and closes.
 * @returns The function returns the reader, the chain to run, and whether the body flows.
 * @internal
 */
export function openBody(
  exchange: Exchange,
  chain: RequestChain,
  framing: BodyFraming,
  source: BodySource,
): OpenedBody {
  const { readsBody, maxBodyBytes } = chain.limits
  if (!readsBody) return { reader: undefined, chain, flowing: false }
  const rejection = earlyRejection(framing, maxBodyBytes)
  const empty = rejection !== undefined || declaresNoBody(framing)
  const reader = new BodyReader(exchange, source, maxBodyBytes, empty)
  if (rejection === undefined) return { reader, chain, flowing: !empty }
  exchange.closeConnection = true
  reader.fail(rejection)
  return { reader, chain: rejectedChain(chain, rejection), flowing: false }
}
