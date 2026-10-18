import { type Context, exchangeOf } from '../context.js'

/**
 * Passes an entry to the logger of the app, when the app has one. When the logger throws, the
 * function drops the entry, so that the package handles the request as it does without a logger.
 *
 * @param context - The middleware passes the context of the request.
 * @param level - The middleware passes the method of the logger to call.
 * @param details - The middleware passes the object of the entry.
 * @param message - The middleware passes the message of the entry.
 * @internal
 */
export function logToApp(context: Context, level: 'warn' | 'error', details: object, message: string): void {
  try {
    exchangeOf(context).runtime.logger?.[level](details, message)
  } catch {
    return
  }
}
