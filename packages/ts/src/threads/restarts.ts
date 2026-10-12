import {
  FIRST_RESTART_DELAY_MS,
  MAX_RESTART_DELAY_MS,
  RESTART_DELAY_GROWTH_FACTOR,
  RESTART_DELAY_RESET_MS,
} from '../constants.js'

/**
 * One place among the worker threads keeps its restart delay in this object. The delay starts at
 * {@link FIRST_RESTART_DELAY_MS}, doubles after each replacement up to {@link MAX_RESTART_DELAY_MS},
 * and returns to the start once a replacement has served for {@link RESTART_DELAY_RESET_MS}.
 *
 * @internal
 */
export class RestartSlot {
  #delay = FIRST_RESTART_DELAY_MS
  #reset: NodeJS.Timeout | undefined
  #restart: NodeJS.Timeout | undefined

  /** The next replacement in this place starts after this many milliseconds. */
  get delay(): number {
    return this.#delay
  }

  /** Records that the worker in this place has started to serve, which starts the reset timer. */
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
   * @returns The method returns `true` once the window holds as many crashes as the limit.
   */
  record(now: number): boolean {
    this.#times.push(now)
    while (this.#times.length > 0 && (this.#times[0] ?? now) <= now - this.#windowMs) this.#times.shift()
    return this.#times.length >= this.#limit
  }
}
