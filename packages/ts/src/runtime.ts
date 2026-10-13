import type { ErrorHandler, Handler, Logger } from './types.js'
import type { PubSubAdapter } from './websocket/types.js'

/**
 * The package shares these settings of one app with every request to that app.
 *
 * @internal
 */
export interface AppRuntime {
  /** The package writes every 500 to this logger. */
  readonly logger: Logger | undefined
  /** The package calls this handler for a path that has no route. */
  readonly notFound: Handler | undefined
  /** The package calls this handler for every error that a middleware or a handler throws. */
  readonly onError: ErrorHandler | undefined
  /** The package receives a request body of up to this many bytes, unless you set another limit on the route. */
  readonly maxBodyBytes: number
  /** The package sends a 503 when a handler takes longer than this many milliseconds, unless the value is 0. */
  readonly timeoutMs: number
  /** The package passes each message that your code publishes to this adapter, which is `undefined` when you pass none. */
  readonly pubsub: PubSubAdapter | undefined
}

/**
 * Through this interface, the package controls the body reader of a request once the response
 * starts.
 *
 * @internal
 */
export interface BodyState {
  /**
   * Sets the reader to discard the rest of the body, and resumes a paused source so that the
   * client can send the rest of the body after the response starts.
   */
  settle(): void
  /**
   * Stops pausing the source for the rest of the request. uWebSockets.js stops writing to a paused
   * socket as well as reading from it, so the package calls this method when a streamed reply
   * starts. The reader can then store chunks that your code is yet to read, up to the body limit
   * of the route.
   */
  keepFlowing(): void
}
