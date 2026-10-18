import type { Context } from '../../context.js'

const ids = new WeakMap<Context, string>()

/**
 * Stores the request ID of a request.
 *
 * @param context - The middleware passes the context of the request.
 * @param id - The middleware passes the ID that it kept or generated.
 * @internal
 */
export function setRequestId(context: Context, id: string): void {
  ids.set(context, id)
}

/**
 * Returns the request ID that `requestId()` kept from a trusted proxy or generated for a request.
 *
 * @param context - You pass the context of the request.
 * @returns The function returns the ID, or `undefined` when `requestId()` does not wrap the request.
 */
export function requestIdOf(context: Context): string | undefined {
  return ids.get(context)
}
