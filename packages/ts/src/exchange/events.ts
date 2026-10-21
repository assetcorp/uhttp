import type { UhttpError } from '../errors.js'
import { addListener, type OnceListeners } from '../listeners.js'

/**
 * The package keeps the abort signal and the listeners of one request in this object, which it
 * creates only when code asks for the signal or adds a listener, or when the request ends early.
 *
 * @internal
 */
export class ExchangeEvents {
  #controller: AbortController | undefined
  #signalFired = false
  #signalReason: unknown
  #released: UhttpError | undefined
  #closing: OnceListeners<void> | undefined
  #disconnection: OnceListeners<void> | undefined
  #release: OnceListeners<UhttpError> | undefined

  /**
   * Returns the abort signal of the request, which the package creates on the first call.
   *
   * @returns The getter returns the same signal on every call.
   */
  get signal(): AbortSignal {
    if (this.#controller === undefined) {
      this.#controller = new AbortController()
      if (this.#signalFired) this.#controller.abort(this.#signalReason)
    }
    return this.#controller.signal
  }

  /**
   * Fires the abort signal, now or when code first asks for it.
   *
   * @param reason - The package passes the reason of the abort.
   */
  fireSignal(reason: unknown): void {
    this.#signalFired = true
    this.#signalReason = reason
    this.#controller?.abort(reason)
  }

  /**
   * Adds a listener that the package calls once when the client goes or the response ends.
   *
   * @param listener - The package calls this function once.
   */
  onClose(listener: () => void): void {
    this.#closing = addListener(this.#closing, listener)
  }

  /**
   * Calls every close listener once.
   */
  fireClose(): void {
    this.#closing?.fire(undefined)
  }

  /**
   * Adds a listener that the package calls once when the connection of the request closes.
   *
   * @param listener - The package calls this function once.
   */
  onDisconnect(listener: () => void): void {
    this.#disconnection = addListener(this.#disconnection, listener)
  }

  /**
   * Calls every disconnect listener once.
   */
  fireDisconnect(): void {
    this.#disconnection?.fire(undefined)
  }

  /**
   * Adds a listener that the package calls once with the error that ends the reading of the body.
   * When that error already exists, the method calls the listener at once.
   *
   * @param listener - The package calls this function once.
   */
  onRelease(listener: (error: UhttpError) => void): void {
    if (this.#released !== undefined) listener(this.#released)
    else this.#release = addListener(this.#release, listener)
  }

  /**
   * Calls every release listener once with the error that ends the reading of the body. The method
   * does nothing after the first call.
   *
   * @param error - The package passes the error that the body reader and the uploads fail with.
   */
  release(error: UhttpError): void {
    if (this.#released !== undefined) return
    this.#released = error
    this.#release?.fire(error)
  }
}
