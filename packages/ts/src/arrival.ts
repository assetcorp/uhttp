import { DISCARDABLE_BODY_BYTES } from './constants.js'
import { addListener, type OnceListeners } from './listeners.js'

/**
 * The package follows the arrival of one request body in this object, so that it can tell how much
 * of the body is still on its way when the response starts.
 *
 * @internal
 */
export class BodyArrival {
  #arriving = false
  #remaining: number | undefined
  #end: OnceListeners<void> | undefined

  /** This is `true` from the call to {@link BodyArrival.expect} until the last byte of the body arrives. */
  get arriving(): boolean {
    return this.#arriving
  }

  /**
   * This is `true` while more of the body is on its way than the package discards to keep the
   * connection open, which includes a chunked body of unknown length.
   */
  get unbounded(): boolean {
    return this.#arriving && (this.#remaining === undefined || this.#remaining > DISCARDABLE_BODY_BYTES)
  }

  /**
   * Records that the package listens for the body until its last byte arrives.
   *
   * @param declaredLength - The package passes the length that the request declares, which is `undefined` for a chunked body.
   */
  expect(declaredLength: number | undefined): void {
    this.#arriving = true
    this.#remaining = declaredLength
  }

  /**
   * Counts the bytes of a chunk of the body against the declared length.
   *
   * @param bytes - The package passes the size of the chunk in bytes.
   */
  received(bytes: number): void {
    if (this.#remaining !== undefined) this.#remaining -= bytes
  }

  /**
   * Records that the last byte of the body arrived, and then calls every listener that waits for
   * it. Without an earlier call to {@link BodyArrival.expect}, the method does nothing.
   */
  ended(): void {
    if (!this.#arriving) return
    this.#arriving = false
    this.#end?.fire(undefined)
  }

  /**
   * Adds a listener that the package calls once the last byte of the body arrives, or at once when
   * no more of the body is on its way.
   *
   * @param listener - The package calls this function once.
   */
  onEnd(listener: () => void): void {
    if (this.#arriving) this.#end = addListener(this.#end, listener)
    else listener()
  }
}
