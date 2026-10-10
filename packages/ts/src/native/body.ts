import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { type OpenedBody, openBody } from '../body/index.js'
import type { Exchange } from '../exchange.js'
import type { RequestChain } from '../resolve.js'
import type { RequestFraming } from './framing.js'

const EMPTY = new Uint8Array(0)

function headerOf(req: HttpRequest, name: string): string | undefined {
  const value = req.getHeader(name)
  return value === '' ? undefined : value
}

/**
 * Follows a request body that no reader takes, so that the package learns when its last byte
 * arrives on a connection that closes after the response.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request, which records the end of the body.
 * @internal
 */
export function followBody(res: HttpResponse, exchange: Exchange): void {
  exchange.expectBody()
  res.onData((_chunk, isLast) => {
    if (isLast) exchange.bodyEnded()
  })
}

/**
 * Attaches the body reader of a request inside the synchronous handler of uWebSockets.js, after
 * the copy of the request. The function attaches an `onData` handler only to a request with a body
 * to read, and it copies each chunk before uWebSockets.js frees it. On a connection that closes
 * after the response, it also follows a body that no reader takes, so that the response can wait
 * for its last byte.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param req - The package passes the request of uWebSockets.js, which is valid until the handler returns.
 * @param exchange - The package passes the state of the request.
 * @param chain - The package passes the chain of the request, with the limits of the route.
 * @param framing - The package passes the framing headers that it read from the request.
 * @returns The function returns the reader and the chain to run.
 * @internal
 */
export function attachBody(
  res: HttpResponse,
  req: HttpRequest,
  exchange: Exchange,
  chain: RequestChain,
  framing: RequestFraming,
): OpenedBody {
  const follows = framing.declaresBody && exchange.clientCloses
  if (!chain.limits.readsBody) {
    if (follows) followBody(res, exchange)
    return { reader: undefined, chain, flowing: false }
  }
  const source = {
    pause: () => {
      if (!exchange.closed) res.pause()
    },
    resume: () => {
      if (!exchange.closed) res.resume()
    },
    close: () => {
      if (exchange.closed) return
      res.close()
      exchange.abort()
    },
  }
  const opened = openBody(
    exchange,
    chain,
    {
      contentLength: framing.contentLength,
      transferEncoding: framing.transferEncoding,
      contentEncoding: headerOf(req, 'content-encoding'),
    },
    source,
  )
  const { reader } = opened
  if (opened.flowing && reader !== undefined) {
    exchange.expectBody()
    res.onData((chunk, isLast) => {
      reader.push(reader.accepting && chunk.byteLength > 0 ? new Uint8Array(chunk.slice(0)) : EMPTY, isLast)
    })
  } else if (follows) {
    followBody(res, exchange)
  }
  return opened
}
