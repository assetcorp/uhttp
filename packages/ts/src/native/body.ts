import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { type OpenedBody, openBody } from '../body/index.js'
import type { Exchange } from '../exchange.js'
import type { RequestChain } from '../resolve.js'

const EMPTY = new Uint8Array(0)

function headerOf(req: HttpRequest, name: string): string | undefined {
  const value = req.getHeader(name)
  return value === '' ? undefined : value
}

/**
 * Attaches the body reader of a request inside the synchronous handler of uWebSockets.js, after
 * the copy of the request. The function attaches an `onData` handler only to a request with a body
 * to read, and it copies each chunk before uWebSockets.js frees it.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param req - The package passes the request of uWebSockets.js, which is valid until the handler returns.
 * @param exchange - The package passes the state of the request.
 * @param chain - The package passes the chain of the request, with the limits of the route.
 * @param contentLength - The package passes the raw `content-length` header that it copied.
 * @returns The function returns the reader and the chain to run.
 * @internal
 */
export function attachBody(
  res: HttpResponse,
  req: HttpRequest,
  exchange: Exchange,
  chain: RequestChain,
  contentLength: string | undefined,
): OpenedBody {
  if (!chain.limits.readsBody) return { reader: undefined, chain, flowing: false }
  const framing = {
    contentLength,
    transferEncoding: headerOf(req, 'transfer-encoding'),
    contentEncoding: headerOf(req, 'content-encoding'),
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
  const opened = openBody(exchange, chain, framing, source)
  const { reader } = opened
  if (opened.flowing && reader !== undefined) {
    res.onData((chunk, isLast) => {
      reader.push(reader.accepting && chunk.byteLength > 0 ? new Uint8Array(chunk.slice(0)) : EMPTY, isLast)
    })
  }
  return opened
}
