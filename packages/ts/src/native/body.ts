import type { HttpResponse } from 'uWebSockets.js'
import { type BodySource, declaredLength, type OpenedBody, openBody } from '../body/index.js'
import type { Exchange } from '../exchange.js'
import type { RequestChain } from '../resolve.js'
import { closeConnection } from './close.js'
import type { RequestFraming } from './framing.js'

const EMPTY = new Uint8Array(0)

function sourceOf(res: HttpResponse, exchange: Exchange): BodySource {
  return {
    pause: () => {
      if (!exchange.closed) res.pause()
    },
    resume: () => {
      if (!exchange.closed) res.resume()
    },
    close: () => closeConnection(res, exchange),
  }
}

function listenForBody(
  res: HttpResponse,
  exchange: Exchange,
  framing: RequestFraming,
  take: (chunk: ArrayBuffer, isLast: boolean) => void,
): void {
  const { arrival } = exchange
  arrival.expect(declaredLength(framing))
  res.onData((chunk, isLast) => {
    arrival.received(chunk.byteLength)
    take(chunk, isLast)
  })
}

/**
 * Attaches the body reader of a request inside the synchronous handler of uWebSockets.js, after
 * the copy of the request. The function copies each chunk for the reader before uWebSockets.js
 * frees it. For a body without a reader, it still counts the chunks as they arrive, so that the
 * package knows how much of the body is on its way when the response starts.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param chain - The package passes the chain of the request, with the limits of the route.
 * @param framing - The package passes the framing headers that it read from the request.
 * @returns The function returns the reader and the chain that the package then calls.
 * @internal
 */
export function attachBody(
  res: HttpResponse,
  exchange: Exchange,
  chain: RequestChain,
  framing: RequestFraming,
): OpenedBody {
  const opened = chain.limits.readsBody
    ? openBody(exchange, chain, framing, sourceOf(res, exchange))
    : { reader: undefined, chain, flowing: false }
  const { reader } = opened
  if (opened.flowing && reader !== undefined) {
    listenForBody(res, exchange, framing, (chunk, isLast) => {
      reader.push(reader.accepting && chunk.byteLength > 0 ? new Uint8Array(chunk.slice(0)) : EMPTY, isLast)
    })
  } else if (framing.declaresBody) {
    followBody(res, exchange, framing)
  }
  return opened
}

/**
 * Counts the chunks of a request body that no reader takes, so that the package knows how much of
 * the body is on its way when the response starts and when the last byte arrives.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @param exchange - The package passes the state of the request, which follows the arrival of the body.
 * @param framing - The package passes the framing headers that it read from the request.
 * @internal
 */
export function followBody(res: HttpResponse, exchange: Exchange, framing: RequestFraming): void {
  listenForBody(res, exchange, framing, (_chunk, isLast) => {
    if (isLast) exchange.arrival.ended()
  })
}
