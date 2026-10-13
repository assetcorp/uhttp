import { LONGEST_TIMER_DELAY_MS } from '../constants.js'

/**
 * Waits until some work settles or a grace period ends, whichever comes first, and leaves no timer
 * behind once the work settles.
 *
 * @param work - The package passes the promise of the work, such as a drain.
 * @param graceMs - The package passes the grace period in milliseconds, which the function caps at
 * {@link LONGEST_TIMER_DELAY_MS}.
 * @returns The promise resolves once the work settles or the grace period ends, and it never rejects.
 * @internal
 */
export function withinGrace(work: Promise<unknown>, graceMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.min(graceMs, LONGEST_TIMER_DELAY_MS))
    const settle = (): void => {
      clearTimeout(timer)
      resolve()
    }
    work.then(settle, settle)
  })
}
