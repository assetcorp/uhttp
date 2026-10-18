import { WEBSOCKET_GOING_AWAY_CODE, WEBSOCKET_GOING_AWAY_REASON } from '../constants.js'

/**
 * The app of uWebSockets.js serves every request in this mode.
 *
 * @internal
 */
export const SERVING = 0

/**
 * In this mode, the app of uWebSockets.js serves the requests on its open connections and closes
 * each connection after its reply, because a reload replaces the app.
 *
 * @internal
 */
export const RETIRING = 1

/**
 * In this mode, the app of uWebSockets.js sends a 503 in response to every new request on its open
 * connections, because the server is closing.
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
 * The package moves an app of uWebSockets.js out of {@link SERVING} to one of these modes.
 *
 * @internal
 */
export type LeavingMode = typeof RETIRING | typeof CLOSING

/**
 * The `Drain` class closes each WebSocket through this interface.
 *
 * @internal
 */
export interface ClosableSocket {
  /**
   * Closes the socket with a close frame.
   *
   * @param code - The `Drain` class passes {@link WEBSOCKET_GOING_AWAY_CODE}.
   * @param reason - The `Drain` class passes {@link WEBSOCKET_GOING_AWAY_REASON}.
   */
  end(code: number, reason: string): void
}

/**
 * The package counts the responses that stay open after the handler of uWebSockets.js returns,
 * and the WebSockets that are open, on one app of uWebSockets.js, so that the package can wait
 * until they all end before it closes that app during a close or a reload.
 *
 * @internal
 */
export class Drain {
  /** The app is in this mode, which the package changes only from {@link SERVING} towards {@link CLOSING}. */
  mode: DrainMode = SERVING
  /** This is `true` when the app serves HTTPS, which means that every client of the app connects over TLS. */
  readonly secure: boolean
  readonly #sockets = new Set<ClosableSocket>()
  #pending = 0
  #emptied: PromiseWithResolvers<void> | undefined

  /**
   * Creates the drain of one app of uWebSockets.js.
   *
   * @param secure - The package passes `true` for an app that serves HTTPS.
   */
  constructor(secure: boolean) {
    this.secure = secure
  }

  /** Records a response that stays open after the handler of uWebSockets.js returns. */
  started(): void {
    this.#pending++
  }

  /** Records that a response that {@link Drain.started} counted ends or loses its connection. */
  finished(): void {
    this.#pending--
    this.#settle()
  }

  /**
   * Records a WebSocket that opens while the app serves, and closes the WebSocket with 1001 at once
   * in any other mode.
   *
   * @param socket - The package passes the socket that opens.
   */
  opened(socket: ClosableSocket): void {
    if (this.mode === SERVING) this.#sockets.add(socket)
    else socket.end(WEBSOCKET_GOING_AWAY_CODE, WEBSOCKET_GOING_AWAY_REASON)
  }

  /**
   * Records that a WebSocket closes.
   *
   * @param socket - The package passes the socket that closes.
   */
  closed(socket: ClosableSocket): void {
    if (this.#sockets.delete(socket)) this.#settle()
  }

  /**
   * Moves the app to {@link RETIRING} or {@link CLOSING}, and closes every open WebSocket with
   * 1001. A later call can move a retiring app on to {@link CLOSING}.
   *
   * @param mode - The package passes {@link RETIRING} for a reload and {@link CLOSING} for a close.
   * @returns The promise resolves once every counted response ends and every WebSocket closes.
   * Every call returns the same promise.
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
