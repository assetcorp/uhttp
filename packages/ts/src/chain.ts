import type { Context } from './context.js'
import { isClientError, UhttpError } from './errors.js'
import type { Exchange } from './exchange.js'
import { isThenable } from './middleware/options.js'
import { errorReply, Reply } from './reply.js'
import type { BeforeHandler, Handler, Logger, MiddlewareHandler, Next } from './types.js'

/**
 * The package calls each middleware of a chain in this form, with the `before` and the `handle`
 * function of the middleware, either of which can be missing.
 *
 * @internal
 */
export interface ChainLayer {
  /** The package calls this function first, without `next`. */
  readonly before: BeforeHandler | undefined
  /** The package calls this function after `before` passes the request on, with `next`. */
  readonly handle: MiddlewareHandler | undefined
}

const INTERNAL_ERROR_MESSAGE = 'The request failed.'
const MISSING_REPLY_MESSAGE =
  'The middleware chain ended without a reply. Return the reply that a helper such as c.json() builds, and await next() in every middleware.'
const NEXT_CALLED_TWICE_MESSAGE = 'A middleware called next() a second time.'

/**
 * Returns the reply that the default error handler sends. For a `UhttpError` below 500 or with the
 * code `HANDLER_TIMEOUT`, the reply has the status, the code, and the message of the error. For any
 * other error, it is a 500 whose message is 'The request failed.' alone.
 *
 * @param error - The package passes the error that it caught.
 * @returns The function returns a JSON error reply.
 * @internal
 */
export function defaultErrorReply(error: unknown): Reply {
  if (isClientError(error)) return errorReply(error)
  return errorReply(new UhttpError('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE))
}

/**
 * Passes an error to the logger, with the method and the path of the request, when the error
 * leads to a 500. When the logger throws, the function returns without a log entry.
 *
 * @param logger - The package passes the logger of the app, which is `undefined` when you passed none.
 * @param error - The package passes the error that it caught.
 * @param method - The client sent this method.
 * @param path - The package passes the path of the request without its query string.
 * @internal
 */
export function logServerError(logger: Logger | undefined, error: unknown, method: string, path: string): void {
  if (logger === undefined) return
  if (isClientError(error)) return
  try {
    logger.error({ err: error, method, path }, INTERNAL_ERROR_MESSAGE)
  } catch {
    return
  }
}

function logFor(logger: Logger | undefined, error: unknown, context: Context): void {
  logServerError(logger, error, context.req.method, context.req.path)
}

function missingReply(): UhttpError {
  return new UhttpError('MISSING_REPLY', MISSING_REPLY_MESSAGE)
}

/**
 * Returns the reply for an error: the reply of the app's error handler, or the default error reply
 * when the app has none or when that handler throws, rejects, or returns something other than a
 * reply. The function logs every error for which the client receives a 500. For a
 * `PAYLOAD_TOO_LARGE` error, it makes the package close the connection after the reply, whatever
 * the error handler returns.
 *
 * @param context - The package passes the context of the request.
 * @param exchange - The package passes the state of the request, from which the function takes the error handler.
 * @param error - The package passes the error that it caught.
 * @returns The function returns the reply, or a promise of the reply that never rejects.
 * @internal
 */
export function replyForError(context: Context, exchange: Exchange, error: unknown): Reply | Promise<Reply> {
  const { logger, onError } = exchange.runtime
  if (error instanceof UhttpError && error.code === 'PAYLOAD_TOO_LARGE') exchange.closeAfterReply = true
  logFor(logger, error, context)
  if (onError === undefined) return defaultErrorReply(error)
  const fallBack = (handlerError: unknown): Reply => {
    logFor(logger, handlerError, context)
    return defaultErrorReply(error)
  }
  let result: unknown
  try {
    result = onError(error, context)
  } catch (handlerError) {
    return fallBack(handlerError)
  }
  if (result instanceof Reply) return result
  if (!(result instanceof Promise)) return fallBack(missingReply())
  return result.then(value => (value instanceof Reply ? value : fallBack(missingReply())), fallBack)
}

function assignLater(exchange: Exchange, reply: Promise<Reply>): Promise<void> {
  return reply.then(value => exchange.assign(value))
}

function fail(context: Context, exchange: Exchange, error: unknown): undefined | Promise<void> {
  const reply = replyForError(context, exchange, error)
  if (reply instanceof Reply) {
    exchange.assign(reply)
    return undefined
  }
  return assignLater(exchange, reply)
}

function settleHandler(context: Context, exchange: Exchange, result: Promise<unknown>): Promise<void> {
  return result.then(
    value => {
      if (value instanceof Reply) {
        exchange.assign(value)
        return undefined
      }
      return fail(context, exchange, missingReply())
    },
    error => fail(context, exchange, error),
  )
}

function callHandler(context: Context, exchange: Exchange, handler: Handler): undefined | Promise<void> {
  let result: unknown
  try {
    result = handler(context)
  } catch (error) {
    return fail(context, exchange, error)
  }
  if (result instanceof Reply) {
    exchange.assign(result)
    return undefined
  }
  if (!(result instanceof Promise)) return fail(context, exchange, missingReply())
  return settleHandler(context, exchange, result)
}

function dispatch(
  context: Context,
  exchange: Exchange,
  layers: readonly ChainLayer[],
  handler: Handler,
  index: number,
): undefined | Promise<void> {
  const layer = layers[index]
  if (layer === undefined) return callHandler(context, exchange, handler)
  if (layer.before !== undefined) return callBefore(context, exchange, layers, handler, index, layer.before)
  return pass(context, exchange, layers, handler, index)
}

function pass(
  context: Context,
  exchange: Exchange,
  layers: readonly ChainLayer[],
  handler: Handler,
  index: number,
): undefined | Promise<void> {
  const handle = layers[index]?.handle
  if (handle === undefined) return dispatch(context, exchange, layers, handler, index + 1)
  return callLayer(context, exchange, layers, handler, index, handle)
}

function callBefore(
  context: Context,
  exchange: Exchange,
  layers: readonly ChainLayer[],
  handler: Handler,
  index: number,
  before: BeforeHandler,
): undefined | Promise<void> {
  let result: unknown
  let waits: boolean
  try {
    result = before(context)
    waits = !(result instanceof Reply) && isThenable(result)
  } catch (error) {
    return fail(context, exchange, error)
  }
  if (result instanceof Reply) {
    exchange.assign(result)
    return undefined
  }
  if (!waits) return pass(context, exchange, layers, handler, index)
  return Promise.resolve(result).then(
    value => {
      if (!(value instanceof Reply)) return pass(context, exchange, layers, handler, index)
      exchange.assign(value)
      return undefined
    },
    error => fail(context, exchange, error),
  )
}

function callLayer(
  context: Context,
  exchange: Exchange,
  layers: readonly ChainLayer[],
  handler: Handler,
  index: number,
  layer: MiddlewareHandler,
): undefined | Promise<void> {
  let called = false
  const next: Next = () => {
    if (called) return Promise.reject(new UhttpError('NEXT_CALLED_TWICE', NEXT_CALLED_TWICE_MESSAGE))
    called = true
    return Promise.resolve(dispatch(context, exchange, layers, handler, index + 1))
  }
  let result: unknown
  try {
    result = layer(context, next)
  } catch (error) {
    return fail(context, exchange, error)
  }
  if (result instanceof Reply) {
    exchange.assign(result)
    return undefined
  }
  if (!(result instanceof Promise)) return undefined
  return result.then(
    value => {
      if (value instanceof Reply) exchange.assign(value)
    },
    error => fail(context, exchange, error),
  )
}

function ensureReply(context: Context, exchange: Exchange): undefined | Promise<void> {
  if (exchange.reply !== undefined) return undefined
  return fail(context, exchange, missingReply())
}

/**
 * Sends a request through its middleware chain and its handler. The function turns an error into
 * a reply at each middleware boundary, so that an outer middleware receives the error reply after
 * `await next()`. When the function finishes, the request has a reply.
 *
 * @param context - The package passes the context of the request.
 * @param exchange - The package passes the state of the request, which stores the reply.
 * @param layers - The package passes the middleware in the order app, group, then route.
 * @param handler - The package passes the handler at the end of the chain.
 * @returns The function returns `undefined` when the chain finished synchronously. Otherwise, it
 * returns a promise that resolves once the chain finishes, and that promise never rejects.
 * @internal
 */
export function runChain(
  context: Context,
  exchange: Exchange,
  layers: readonly ChainLayer[],
  handler: Handler,
): undefined | Promise<void> {
  const result = dispatch(context, exchange, layers, handler, 0)
  if (result === undefined) return ensureReply(context, exchange)
  return ensureReplyLater(context, exchange, result)
}

function ensureReplyLater(context: Context, exchange: Exchange, chain: Promise<void>): Promise<void> {
  return chain.then(() => ensureReply(context, exchange))
}
