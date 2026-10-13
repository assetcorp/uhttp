import { WEBSOCKET_GOING_AWAY_CODE, WEBSOCKET_GOING_AWAY_REASON } from '../constants.js'

/**
 * The app of uWebSockets.js serves every request in this mode.
 *
 * @internal
 */
export const SERVING = 0

/**
 * The app of uWebSockets.js serves the requests on its open connections in this mode and closes
 * each connection after its reply, because a reload has replaced the app.
 *
 * @internal
 */
export const RETIRING = 1

/**
 * The app of uWebSockets.js answers every new request on its open connections with a 503 in this
 * mode, because the server is closing.
 *
 * @internal
 */
export const CLOSING = 2

/**
 * The app of uWebSockets.js on one thread is in one of these modes.
 *
 * @internal
 */
export type DrainMode = typeof SERVING | typeof RETIRING | typeof CLOSING

/**
 * The package moves an app of uWebSockets.js that no longer serves as usual to one of these modes.
 *
 * @internal
 */
export type LeavingMode = typeof RETIRING | typeof CLOSING

/**
 * The drain closes each WebSocket through this interface.
 *
 * @internal
 */
export interface ClosableSocket {
  /**
   * Closes the socket with a close frame.
   *
   * @param code - The drain passes {@link WEBSOCKET_GOING_AWAY_CODE}.
   * @param reason - The drain passes {@link WEBSOCKET_GOING_AWAY_REASON}.
   */
  end(code: number, reason: string): void
}

/**
 * The package counts the responses that stay open after the handler of uWebSockets.js returns,
 * and the WebSockets that are open, on one app of uWebSockets.js, so that the package can wait
 * until they have all ended before it closes that app during a close or a reload.
 *
 * @internal
 */
export class Drain {
  /** The app serves requests in this mode, which only ever moves from {@link SERVING} towards {@link CLOSING}. */
  mode: DrainMode = SERVING
  readonly #sockets = new Set<ClosableSocket>()
  #pending = 0
  #emptied: PromiseWithResolvers<void> | undefined

  /** Records a response that stays open after the handler of uWebSockets.js returns. */
  started(): void {
    this.#pending++
  }

  /** Records that a response that {@link Drain.started} counted has ended or lost its connection. */
  finished(): void {
    this.#pending--
    this.#settle()
  }

  /**
   * Records a WebSocket that has opened, and closes it with 1001 at once when the app no longer serves.
   *
   * @param socket - The package passes the socket that has opened.
   */
  opened(socket: ClosableSocket): void {
    if (this.mode === SERVING) this.#sockets.add(socket)
    else socket.end(WEBSOCKET_GOING_AWAY_CODE, WEBSOCKET_GOING_AWAY_REASON)
  }

  /**
   * Records that a WebSocket has closed.
   *
   * @param socket - The package passes the socket that has closed.
   */
  closed(socket: ClosableSocket): void {
    if (this.#sockets.delete(socket)) this.#settle()
  }

  /**
   * Moves the app to a mode in which it no longer serves as usual, and closes every open WebSocket
   * with 1001. A later call can move a retiring app on to {@link CLOSING}.
   *
   * @param mode - The package passes {@link RETIRING} for a reload and {@link CLOSING} for a close.
   * @returns The promise resolves once every counted response has ended and every WebSocket has
   * closed, and every call returns the same promise.
   */
  start(mode: LeavingMode): Promise<void> {
    if (mode > this.mode) this.mode = mode
    const sockets = [...this.#sockets]
    for (const socket of sockets) socket.end(WEBSOCKET_GOING_AWAY_CODE, WEBSOCKET_GOING_AWAY_REASON)
    this.#emptied ??= Promise.withResolvers<void>()
    this.#settle()
    return this.#emptied.promise
  }

  #settle(): void {
    if (this.#emptied !== undefined && this.#pending === 0 && this.#sockets.size === 0) this.#emptied.resolve()
  }
}
