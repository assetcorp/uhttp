import {
  FIRST_RESTART_DELAY_MS,
  MAX_RESTART_DELAY_MS,
  RESTART_DELAY_GROWTH_FACTOR,
  RESTART_DELAY_RESET_MS,
} from '../constants.js'

/**
 * The supervisor keeps the restart delay of one worker in this object, which every replacement of
 * that worker shares. The delay is {@link FIRST_RESTART_DELAY_MS} at first, and the slot doubles it
 * after each replacement, up to {@link MAX_RESTART_DELAY_MS}. Once a replacement has served for
 * {@link RESTART_DELAY_RESET_MS}, the slot resets the delay to {@link FIRST_RESTART_DELAY_MS}.
 *
 * @internal
 */
export class RestartSlot {
  #delay = FIRST_RESTART_DELAY_MS
  #reset: NodeJS.Timeout | undefined
  #restart: NodeJS.Timeout | undefined

  /** The supervisor starts the next replacement of this worker after this many milliseconds. */
  get delay(): number {
    return this.#delay
  }

  /** Records that the worker has started to serve, and starts the timer that resets the delay. */
  serving(): void {
    clearTimeout(this.#reset)
    this.#reset = setTimeout(() => {
      this.#delay = FIRST_RESTART_DELAY_MS
    }, RESTART_DELAY_RESET_MS)
    this.#reset.unref()
  }

  /**
   * Starts a replacement once the current delay has passed, and doubles the delay for the next one.
   *
   * @param start - The supervisor passes the function that starts the replacement.
   */
  replace(start: () => void): void {
    clearTimeout(this.#reset)
    clearTimeout(this.#restart)
    const delay = this.#delay
    this.#delay = Math.min(delay * RESTART_DELAY_GROWTH_FACTOR, MAX_RESTART_DELAY_MS)
    this.#restart = setTimeout(() => {
      this.#restart = undefined
      start()
    }, delay)
  }

  /** Stops both timers, so that no replacement starts. */
  stop(): void {
    clearTimeout(this.#reset)
    clearTimeout(this.#restart)
    this.#restart = undefined
  }
}

/**
 * The supervisor counts worker crashes in this object, within a window of time that slides.
 *
 * @internal
 */
export class CrashWindow {
  readonly #limit: number
  readonly #windowMs: number
  readonly #times: number[] = []

  /**
   * Creates an empty window.
   *
   * @param limit - The supervisor passes the number of crashes at which the server exits.
   * @param windowMs - The supervisor passes the length of the window in milliseconds.
   */
  constructor(limit: number, windowMs: number) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /**
   * Records a crash.
   *
   * @param now - The supervisor passes the time of the crash from `performance.now()`.
   * @returns The method returns `true` once the window has as many crashes as the limit.
   */
  record(now: number): boolean {
    this.#times.push(now)
    while (this.#times.length > 0 && (this.#times[0] ?? now) <= now - this.#windowMs) this.#times.shift()
    return this.#times.length >= this.#limit
  }
}
