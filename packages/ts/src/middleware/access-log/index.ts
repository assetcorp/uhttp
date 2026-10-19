import { exchangeOf } from '../../context.js'
import type { MiddlewareDefinition } from '../../types.js'
import { clientAddressOf } from '../client.js'
import { logToApp } from '../logger.js'
import { invalidOption, optionsObject } from '../options.js'
import { requestIdOf } from '../request-id/ids.js'
import {
  ACCESS_LOG_LINE_LENGTH_LIMIT,
  DURATION_FRACTION_DIGITS,
  FAILED_WRITE_MESSAGE,
  MISSING_FIELD,
} from './constants.js'

const UNSAFE_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\\]/gu

/**
 * You pass these options to {@link accessLog}.
 */
export interface AccessLogOptions {
  /**
   * The middleware calls this function with each line, without a line break at the end. When you
   * leave it out, the middleware writes each line and a line break to standard output.
   */
  readonly write?: (line: string) => void
}

function writeToStandardOutput(line: string): void {
  process.stdout.write(`${line}\n`)
}

function escapedCharacter(character: string): string {
  const code = character.charCodeAt(0)
  return code > 0xff ? `\\u${code.toString(16)}` : `\\x${code.toString(16).padStart(2, '0')}`
}

function field(text: string | undefined): string {
  if (text === undefined || text === '') return MISSING_FIELD
  return text.replace(UNSAFE_CHARACTER, escapedCharacter)
}

function checkedWrite(value: unknown): (line: string) => void {
  if (value === undefined) return writeToStandardOutput
  if (typeof value !== 'function') throw invalidOption('Set the write option of accessLog() to a function.')
  return line => Reflect.apply(value, undefined, [line])
}

/**
 * Returns a middleware that writes one line for each request once the package sends the response
 * or the client disconnects. Each line consists of the method, the matched route template, the
 * status, the duration in milliseconds, the client address, and the request ID, separated by
 * spaces, as in `GET /users/:id 200 1.4ms 203.0.113.9 6f1c...`. The middleware writes `-` for a
 * field without a value, such as the route of a 404 or the status of a request whose client
 * disconnected before the reply.
 *
 * The middleware leaves the path, the query string, the headers, and the cookies out of the line,
 * because they can contain secrets. It writes every control character, backslash, and Unicode
 * line separator as a `\x` or `\u` escape, so that each request produces exactly one line, and it
 * cuts each line to 2,048 characters.
 *
 * Add `trustedProxies()` before this middleware, so that the middleware writes the address of the
 * client behind your proxy. Add `requestId()` anywhere in the same chain, so that the middleware
 * writes the ID.
 *
 * @param options - You can pass the function that writes each line.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when `write` is not a function.
 */
export function accessLog(options?: AccessLogOptions): MiddlewareDefinition {
  const write = checkedWrite(Reflect.get(optionsObject(options, 'accessLog()'), 'write'))
  return {
    clientAddress: true,
    before(context) {
      const started = performance.now()
      const address = clientAddressOf(context)
      const exchange = exchangeOf(context)
      exchange.onClose(() => {
        const status = exchange.reply?.status
        const duration = (performance.now() - started).toFixed(DURATION_FRACTION_DIGITS)
        const line = `${field(context.req.method)} ${field(context.req.route)} ${status ?? MISSING_FIELD} ${duration}ms ${field(address)} ${field(requestIdOf(context))}`
        try {
          write(line.slice(0, ACCESS_LOG_LINE_LENGTH_LIMIT))
        } catch (error) {
          logToApp(context, 'error', { err: error }, FAILED_WRITE_MESSAGE)
        }
      })
    },
  }
}
