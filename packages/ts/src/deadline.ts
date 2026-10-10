import { replyForError } from './chain.js'
import type { Context } from './context.js'
import { UhttpError } from './errors.js'
import type { Exchange } from './exchange.js'
import { Reply } from './reply.js'

const TIMEOUT_LOG_MESSAGE = 'The handler passed the time limit of its route.'

function warnTimeout(exchange: Exchange, context: Context, timeoutMs: number): void {
  try {
    exchange.runtime.logger?.warn(
      { method: context.req.method, path: context.req.path, timeoutMs },
      TIMEOUT_LOG_MESSAGE,
    )
  } catch {
    return
  }
}

/**
 * Starts the time limit of a handler. When the limit passes before the chain finishes, the function
 * fires the abort signal and releases the body reader and the upload destinations. It then makes
 * the reply of the error handler for `HANDLER_TIMEOUT` the last reply, marks the connection for
 * closing, and calls `send`. The handler goes on executing, but the package discards the reply that
 * the handler returns.
 *
 * @param exchange - The package passes the state of the request.
 * @param context - The package passes the context of the request.
 * @param timeoutMs - The package passes the time limit of the route in milliseconds.
 * @param send - The package calls this function once the reply is ready to send.
 * @returns The function returns a function that stops the time limit, which the package calls once
 * the chain finishes.
 * @internal
 */
export function startDeadline(exchange: Exchange, context: Context, timeoutMs: number, send: () => void): () => void {
  const timer = setTimeout(() => {
    if (exchange.closed) return
    const error = new UhttpError('HANDLER_TIMEOUT', `The handler took longer than its time limit of ${timeoutMs} ms.`)
    warnTimeout(exchange, context, timeoutMs)
    exchange.expire(error)
    const reply = replyForError(context, exchange, error)
    const deliver = (value: Reply): void => {
      exchange.finalize(value)
      send()
    }
    if (reply instanceof Reply) deliver(reply)
    else void reply.then(deliver)
  }, timeoutMs)
  const stop = (): void => clearTimeout(timer)
  exchange.onClose(stop)
  return stop
}
