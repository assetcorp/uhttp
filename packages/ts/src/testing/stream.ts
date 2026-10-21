import { logServerError } from '../chain.js'
import type { Context } from '../context.js'
import type { Exchange } from '../exchange/index.js'
import { type ResponseStream, type StreamProducer, streamShortfallError, streamWriteError } from '../reply.js'

const encoder = new TextEncoder()

/**
 * Returns the body of a streamed reply for {@link App.request}, as a stream that pulls from the
 * producer. Each write of the producer stays pending while the test reads slowly. When the test
 * cancels the body, the package treats the client as gone. When the producer throws, the body
 * errors, so that the test can detect the truncated body.
 *
 * @param exchange - The package passes the state of the request.
 * @param context - The package passes the context of the request, and it logs a failure with the method and the path of that request.
 * @param produce - The package passes the stream producer of the reply.
 * @param length - You declared this length in bytes, and it is `undefined` for a body of unknown length.
 * @returns The function returns the body stream.
 * @internal
 */
export function testStreamBody(
  exchange: Exchange,
  context: Context,
  produce: StreamProducer,
  length: number | undefined,
): ReadableStream<Uint8Array> {
  let accepted = 0
  let returned = false
  let waiters: ((written: boolean) => void)[] = []
  const release = (written: boolean): void => {
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve(written)
  }
  exchange.onClose(() => release(false))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: unknown): void => {
        returned = true
        logServerError(exchange.runtime.logger, error, context.req.method, context.req.path)
        if (exchange.closed) return
        exchange.abort()
        controller.error(error)
      }
      const stream: ResponseStream = {
        get closed() {
          return exchange.closed
        },
        onClose: listener => exchange.onClose(listener),
        write(chunk) {
          if (exchange.closed) return Promise.resolve(false)
          const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
          const error = streamWriteError(returned, accepted, bytes.byteLength, length)
          if (error !== undefined) return Promise.reject(error)
          accepted += bytes.byteLength
          controller.enqueue(bytes)
          if ((controller.desiredSize ?? 0) > 0) return Promise.resolve(true)
          return new Promise(resolve => {
            waiters.push(resolve)
          })
        },
      }
      const finish = (): void => {
        returned = true
        if (exchange.closed) return
        const shortfall = streamShortfallError(accepted, length)
        if (shortfall !== undefined) {
          fail(shortfall)
          return
        }
        exchange.end()
        controller.close()
      }
      let result: void | Promise<void>
      try {
        result = produce(stream)
      } catch (error) {
        fail(error)
        return
      }
      Promise.resolve(result).then(finish, fail)
    },
    pull() {
      release(true)
    },
    cancel() {
      exchange.abort()
    },
  })
}
