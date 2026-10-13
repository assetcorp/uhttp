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
  /** The package calls this handler for every error that the chain throws. */
  readonly onError: ErrorHandler | undefined
  /** The package accepts a request body of up to this many bytes, unless the route sets its own limit. */
  readonly maxBodyBytes: number
  /** A handler has this many milliseconds before the package sends a 503, and 0 means no limit. */
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
   * Makes the reader discard the rest of the body as it arrives, and resumes a paused source, so
   * that the rest of the body keeps arriving after the response starts.
   */
  settle(): void
  /**
   * Stops pausing the source for the rest of the request. uWebSockets.js stops writing to a paused
   * socket as well as reading from it, so the package calls this method when a streamed reply
   * starts. The reader can then hold up to the body limit of the route in chunks that your code
   * hasn't read.
   */
  keepFlowing(): void
}
