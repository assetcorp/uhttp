import type { Context } from './context.js'
import { UhttpError } from './errors.js'
import type { Exchange } from './exchange.js'
import { errorReply, Reply } from './reply.js'
import type { Handler, Logger, MiddlewareHandler, Next } from './types.js'

const INTERNAL_ERROR_MESSAGE = 'The request failed.'
const MISSING_REPLY_MESSAGE =
  'The middleware chain ended without a reply. Return the reply that a helper such as c.json() builds, and await next() in every middleware.'
const NEXT_CALLED_TWICE_MESSAGE = 'A middleware called next() a second time.'

/**
 * Returns the reply that the default error handler sends. For a `UhttpError` below 500, the reply
 * has the status, the code, and the message of the error. For any other error, it is a 500 whose
 * message is 'The request failed.' alone.
 *
 * @param error - The package passes the error that it caught.
 * @returns The function returns a JSON error reply.
 * @internal
 */
export function defaultErrorReply(error: unknown): Reply {
  if (error instanceof UhttpError && error.status < 500) return errorReply(error)
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
  if (error instanceof UhttpError && error.status < 500) return
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

function fail(context: Context, exchange: Exchange, error: unknown): undefined | Promise<void> {
  const { logger, onError } = exchange.runtime
  logFor(logger, error, context)
  if (onError === undefined) {
    exchange.assign(defaultErrorReply(error))
    return undefined
  }
  const fallBack = (handlerError: unknown): void => {
    logFor(logger, handlerError, context)
    exchange.assign(defaultErrorReply(error))
  }
  let result: unknown
  try {
    result = onError(error, context)
  } catch (handlerError) {
    fallBack(handlerError)
    return undefined
  }
  if (result instanceof Reply) {
    exchange.assign(result)
    return undefined
  }
  if (!(result instanceof Promise)) {
    fallBack(missingReply())
    return undefined
  }
  return result.then(value => {
    if (value instanceof Reply) {
      exchange.assign(value)
      return
    }
    fallBack(missingReply())
  }, fallBack)
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

function dispatch(
  context: Context,
  exchange: Exchange,
  layers: readonly MiddlewareHandler[],
  handler: Handler,
  index: number,
): undefined | Promise<void> {
  const layer = layers[index]
  if (layer === undefined) return callHandler(context, exchange, handler)
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
  layers: readonly MiddlewareHandler[],
  handler: Handler,
): undefined | Promise<void> {
  const result = dispatch(context, exchange, layers, handler, 0)
  if (result === undefined) return ensureReply(context, exchange)
  return result.then(() => ensureReply(context, exchange))
}
