/**
 * The package keeps the listeners of an event that happens at most once in this object, such as
 * the end of a response. The caller checks whether the event has already happened before it adds a
 * listener.
 *
 * @internal
 */
export class OnceListeners<T> {
  #listeners: ((value: T) => void)[] = []

  /**
   * Adds a listener that the package calls once with the value of the event.
   *
   * @param listener - The package calls this function when the event happens.
   */
  add(listener: (value: T) => void): void {
    this.#listeners.push(listener)
  }

  /**
   * Calls every listener once with the value of the event, and then forgets them.
   *
   * @param value - The package passes the value of the event to every listener.
   */
  fire(value: T): void {
    const listeners = this.#listeners
    this.#listeners = []
    for (const listener of listeners) listener(value)
  }
}

/**
 * Adds a listener to a list that the caller creates on the first listener, so that a request whose
 * code adds no listener allocates no list.
 *
 * @param list - The caller passes its list, which is `undefined` before the first listener.
 * @param listener - The package calls this function when the event happens.
 * @returns The function returns the list, which the caller stores.
 * @internal
 */
export function addListener<T>(list: OnceListeners<T> | undefined, listener: (value: T) => void): OnceListeners<T> {
  const target = list ?? new OnceListeners<T>()
  target.add(listener)
  return target
}
