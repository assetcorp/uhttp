import { type BodyReader, type BodySource, declaredLength, type OpenedBody, openBody } from '../body/index.js'
import { declaresNoBody } from '../body/reader.js'
import type { Exchange } from '../exchange/index.js'
import type { RequestChain } from '../resolve.js'
import { firstValue, type TestBody, valuesOf } from './parse.js'

type Lines = readonly (readonly [string, string])[]

const encoder = new TextEncoder()

class TestSource implements BodySource {
  readonly #exchange: Exchange
  #resumed: PromiseWithResolvers<void> | undefined

  constructor(exchange: Exchange) {
    this.#exchange = exchange
  }

  pause(): void {
    this.#resumed ??= Promise.withResolvers()
  }

  resume(): void {
    const resumed = this.#resumed
    this.#resumed = undefined
    resumed?.resolve()
  }

  close(): void {
    this.resume()
    this.#exchange.abort()
  }

  ready(): Promise<void> | undefined {
    return this.#resumed?.promise
  }
}

function toBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk)
}

function chunksOf(body: TestBody): AsyncIterator<string | Uint8Array> | Iterator<string | Uint8Array> {
  if (typeof body === 'string' || body instanceof Uint8Array) return [body][Symbol.iterator]()
  if (body instanceof ArrayBuffer) return [new Uint8Array(body)][Symbol.iterator]()
  if (Symbol.asyncIterator in body) return body[Symbol.asyncIterator]()
  return body[Symbol.iterator]()
}

async function pump(
  reader: BodyReader,
  source: TestSource,
  exchange: Exchange,
  body: TestBody,
  declared: number | undefined,
): Promise<void> {
  const chunks = chunksOf(body)
  let sent = 0
  try {
    while (reader.accepting && !exchange.closed) {
      await source.ready()
      if (!reader.accepting || exchange.closed) break
      const next = await chunks.next()
      if (next.done === true) {
        if (declared !== undefined && sent < declared) exchange.abort()
        else reader.push(new Uint8Array(0), true)
        break
      }
      let bytes = toBytes(next.value)
      if (declared !== undefined) bytes = bytes.subarray(0, declared - sent)
      sent += bytes.byteLength
      exchange.arrival.received(bytes.byteLength)
      reader.push(bytes, declared !== undefined && sent >= declared)
    }
  } catch {
    exchange.abort()
  } finally {
    await chunks.return?.()
  }
}

/**
 * Attaches the body reader of a test request, as the package does over uWebSockets.js for a request
 * from the network. The function feeds the chunks of the test body into the reader, stops pulling
 * them while the reader has paused the source, and ends a body at its declared length. It treats a
 * body without a reader as still on its way, as uWebSockets.js does when the package answers
 * before the body arrives.
 *
 * @param exchange - The package passes the state of the request.
 * @param chain - The package passes the chain of the request, with the limits of the route.
 * @param lines - The package passes the header lines of the test request.
 * @param body - The test passed this body, which is `undefined` for a request without one.
 * @returns The function returns the reader and the chain that the package then calls.
 * @internal
 */
export function attachTestBody(
  exchange: Exchange,
  chain: RequestChain,
  lines: Lines,
  body: TestBody | undefined,
): OpenedBody {
  const lengthLines = {
    contentLength: firstValue(lines, 'content-length'),
    transferEncoding: firstValue(lines, 'transfer-encoding'),
  }
  const declaresBody = !declaresNoBody(lengthLines)
  const hasFramingLine = lengthLines.contentLength !== undefined || lengthLines.transferEncoding !== undefined
  const codings = valuesOf(lines, 'content-encoding').filter(value => value !== '')
  const framing = {
    ...lengthLines,
    contentEncoding: hasFramingLine && codings.length > 0 ? codings.join(', ') : undefined,
  }
  const source = new TestSource(exchange)
  const opened = openBody(exchange, chain, framing, source)
  const { reader } = opened
  const declared = declaredLength(framing)
  if (opened.flowing && reader !== undefined) {
    exchange.arrival.expect(declared)
    void pump(reader, source, exchange, body ?? [], declared)
  } else if (declaresBody) {
    exchange.arrival.expect(declared)
  }
  return opened
}
