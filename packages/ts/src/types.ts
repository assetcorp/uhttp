import type { Context } from './context.js'
import type { Reply } from './reply.js'

/**
 * A handler is a function that receives the {@link Context} of one request and returns a
 * {@link Reply} or a promise of one.
 *
 * @param context - The package passes the context of the request to the handler.
 * @returns The handler returns the reply, or a promise that resolves to the reply.
 */
export type Handler = (context: Context) => Reply | Promise<Reply>

/**
 * A middleware calls `next` to pass the request on, and it gets back a promise that settles once
 * every inner middleware and the handler have finished.
 *
 * @returns The promise of the first call resolves once the inner layers finish, and it never
 * rejects, because the package turns an error inside them into a reply first. A second call
 * returns a promise that rejects with a {@link UhttpError} with the code `NEXT_CALLED_TWICE`.
 */
export type Next = () => Promise<void>

/**
 * A middleware function receives the {@link Context} of one request and `next`. It can end the
 * request with its own {@link Reply}, or it can call `next` and work on the reply afterwards.
 *
 * @param context - The package passes the context of the request to the middleware.
 * @param next - The middleware calls this function at most once to pass the request on.
 * @returns The middleware returns a reply to replace the current one, or nothing to keep it.
 */
export type MiddlewareHandler = (
  context: Context,
  next: Next,
) => Reply | void | Promise<Reply | undefined> | Promise<void>

/**
 * You write a middleware in this form when it uses request headers or the client address, so that
 * the package copies them before the first `await`.
 */
export interface MiddlewareDefinition {
  /** The package copies these request headers for every route that this middleware wraps. */
  readonly headers?: readonly string[]
  /** When this is `true`, the package copies the client address for every route that this middleware wraps. */
  readonly clientAddress?: boolean
  /** The package calls this function for each request that passes through the middleware. */
  readonly handle: MiddlewareHandler
}

/**
 * You add a middleware to the app, to a group, or to one route, either as a function or as a
 * {@link MiddlewareDefinition}, which declares the request headers and the client address that the
 * middleware uses.
 */
export type Middleware = MiddlewareHandler | MiddlewareDefinition

/**
 * You pass these options to a route, before its handler, to declare the request headers and the
 * client address that the handler uses.
 */
export interface RouteOptions {
  /**
   * The package copies these request headers for the route. With `'all'`, it copies every header,
   * which suits a route such as a proxy that forwards headers whose names you can't list in advance.
   */
  readonly headers?: readonly string[] | 'all'
  /** When this is `true`, the package copies the client address for the route. */
  readonly clientAddress?: boolean
  /**
   * When this is `true`, the package attaches a body reader for the route. It attaches one on
   * POST, PUT, and PATCH routes unless you set `false`, and on no other route unless you set `true`,
   * because the package does more work on every request of a route with a reader.
   */
  readonly body?: boolean
  /** The package applies this limit in bytes to the body of each request of the route, in place of the limit of the app. */
  readonly maxBodyBytes?: number
  /** The package applies this time limit in milliseconds to the route in place of the one of the app, and 0 switches it off. */
  readonly timeoutMs?: number
}

/**
 * You pass a route any middleware for that route alone and any {@link RouteOptions} object, and
 * you pass the handler last.
 */
export type RouteArguments = readonly [...stack: (Middleware | RouteOptions)[], handler: Handler]

/**
 * An error handler receives an error that a middleware or a handler threw and returns the reply
 * for the client.
 *
 * @param error - The package passes the error that it caught.
 * @param context - The package passes the context of the request.
 * @returns The error handler returns the reply, or a promise that resolves to the reply.
 */
export type ErrorHandler = (error: unknown, context: Context) => Reply | Promise<Reply>

/**
 * You can pass a logger with pino's `info`, `warn`, and `error` methods, each of which takes an
 * object and a message.
 */
export interface Logger {
  /**
   * The package calls this method for an event that you need not act on.
   *
   * @param details - The package passes the details of the event.
   * @param message - The package passes one sentence about the event.
   */
  info(details: object, message: string): void
  /**
   * The package calls this method for an event that you may want to act on.
   *
   * @param details - The package passes the details of the event.
   * @param message - The package passes one sentence about the event.
   */
  warn(details: object, message: string): void
  /**
   * The package calls this method for every 500, with the error under `err` and with the method
   * and the path of the request.
   *
   * @param details - The package passes the error, the method, and the path.
   * @param message - The package passes one sentence about the failure.
   */
  error(details: object, message: string): void
}

/**
 * You pass these options to {@link createApp} to choose the logger, the not-found handler, the
 * error handler, the body limit, and the time limit.
 */
export interface AppOptions {
  /**
   * The package answers 413 to a request body larger than this many bytes, which is 1 MiB by
   * default. A route can set its own limit.
   */
  readonly maxBodyBytes?: number
  /**
   * When a handler takes longer than this many milliseconds, the package fires the abort signal of
   * the request and sends a 503. With 0, which is the default, the app has no time limit.
   */
  readonly timeoutMs?: number
  /** The package writes every 500 to this logger, and it writes nothing when you leave it out. */
  readonly logger?: Logger
  /**
   * The package calls this handler for a request to a path that has no route, after the app's
   * middleware. When you leave it out, the client receives a JSON 404.
   */
  readonly notFound?: Handler
  /**
   * The package calls this handler for every error that a middleware or a handler throws. When
   * you leave it out, the client receives `{ error: { code, message } }`.
   */
  readonly onError?: ErrorHandler
}
