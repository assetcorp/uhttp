import type { HttpResponse } from 'uWebSockets.js'
import { logServerError } from '../chain.js'
import type { Context } from '../context.js'
import { startDeadline } from '../deadline.js'
import type { Exchange } from '../exchange/index.js'
import type { Reply } from '../reply.js'
import { closeConnection } from './close.js'
import { writeCrash, writeReply, writeReplyAlone } from './write.js'

/**
 * Writes the reply of a chain that finished inside the synchronous handler of uWebSockets.js.
 * When writing the reply throws, the function logs the error and closes the connection.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param context - The package passes the context of the request.
 * @returns The function returns `true` when the response has ended or the connection has closed.
 * @internal
 */
export function finish(res: HttpResponse, exchange: Exchange, context: Context): boolean {
  const reply = exchange.reply
  if (exchange.closed) return true
  if (reply === undefined) return false
  try {
    return writeReply(res, exchange, context, reply)
  } catch (error) {
    return abandon(res, exchange, error, context)
  }
}

/**
 * Writes a plain 200 for a request other than HEAD on a route without middleware and without a
 * body reader, through {@link writeReplyAlone}, which makes one call into uWebSockets.js for the
 * head of the reply. When writing throws, the function logs the error and closes the connection.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request, whose current reply is the reply.
 * @param context - The package passes the context of the request.
 * @param reply - The package passes the reply to write.
 * @returns The function returns `true` when the response has ended or the connection has closed,
 * and `false` when it wrote nothing because the reply needs the full path of {@link finish}.
 * @internal
 */
export function finishPlainly(res: HttpResponse, exchange: Exchange, context: Context, reply: Reply): boolean {
  try {
    return !exchange.closed && writeReplyAlone(res, exchange, reply)
  } catch (error) {
    return abandon(res, exchange, error, context)
  }
}

/**
 * Writes the reply of a chain that finishes after the synchronous handler of uWebSockets.js has
 * returned. When the route has a time limit, the function starts the deadline, which writes the
 * 503 if the chain passes the limit, and the package then discards the reply of the chain.
 *
 * @param res - The package passes the response of uWebSockets.js, which stays open.
 * @param exchange - The package passes the state of the request.
 * @param context - The package passes the context of the request.
 * @param timeoutMs - The route allows its handler this many milliseconds, and 0 sets no limit.
 * @param pending - The package passes the promise of the chain, which never rejects.
 * @internal
 */
export function finishLater(
  res: HttpResponse,
  exchange: Exchange,
  context: Context,
  timeoutMs: number,
  pending: Promise<void>,
): void {
  const stop =
    timeoutMs > 0 ? startDeadline(exchange, context, timeoutMs, () => finishCorked(res, exchange, context)) : undefined
  pending.then(() => {
    if (exchange.timedOut) return
    stop?.()
    finishCorked(res, exchange, context)
  })
}

function finishCorked(res: HttpResponse, exchange: Exchange, context: Context): void {
  const reply = exchange.reply
  if (exchange.closed || reply === undefined) return
  try {
    res.cork(() => writeReply(res, exchange, context, reply))
  } catch (error) {
    abandon(res, exchange, error, context)
  }
}

/**
 * Logs an error that the package caught before it called any middleware, and answers with the
 * default 500.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param error - The package passes the error that it caught.
 * @param method - The client sent this method.
 * @param path - The package passes the path of the request.
 * @returns The function returns `true` when the response has ended or the connection has closed.
 * @internal
 */
export function crash(res: HttpResponse, exchange: Exchange, error: unknown, method: string, path: string): boolean {
  logServerError(exchange.runtime.logger, error, method, path)
  return writeCrash(res, exchange, method === 'HEAD')
}

/**
 * Logs an error that writing a reply threw, and closes the connection.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param error - The package passes the error that writing threw.
 * @param context - The package passes the context of the request.
 * @returns The function returns `true`, because the connection has closed.
 * @internal
 */
export function abandon(res: HttpResponse, exchange: Exchange, error: unknown, context: Context): boolean {
  logServerError(exchange.runtime.logger, error, context.req.method, context.req.path)
  closeConnection(res, exchange)
  return true
}
