import { UhttpError } from '../errors.js'
import { headerBytes, settableHeaderName } from '../headers.js'
import type { PreparedHeader, PreparedName } from '../response.js'

/**
 * A middleware builds each fixed response header in this form once, at startup.
 *
 * @internal
 */
export type FixedHeader = PreparedHeader

/**
 * Returns the prepared form of a response header name that the package defines, so that a
 * middleware can send a value that it builds for each request under that name.
 *
 * @param lowerName - The middleware passes a lowercase header name that is not a framing header.
 * @returns The function returns the name with its bytes.
 * @internal
 */
export function fixedName(lowerName: string): PreparedName {
  return { name: lowerName, encoded: { name: headerBytes(lowerName), value: undefined } }
}

/**
 * Returns the error that a middleware throws for an option that it can't use.
 *
 * @param message - The middleware passes an instruction of one sentence about the value to pass.
 * @returns The function returns a {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS`.
 * @internal
 */
export function invalidOption(message: string): UhttpError {
  return new UhttpError('INVALID_MIDDLEWARE_OPTIONS', message)
}

/**
 * Returns the options object that you passed to a middleware, after checking that it is an object.
 *
 * @param value - The middleware passes the options that it received.
 * @param owner - The middleware passes its own name, such as `cors()`.
 * @returns The function returns the object, or an empty object for `undefined`.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` for any value other than an
 * object or `undefined`.
 * @internal
 */
export function optionsObject(value: unknown, owner: string): object {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidOption(`Pass the options of ${owner} as an object.`)
  }
  return value
}

/**
 * Returns a whole-number option after checking its range.
 *
 * @param value - The middleware passes the value of the option.
 * @param name - The middleware passes the name of the option for the message of the error.
 * @param low - The value can be this number or more.
 * @param high - The value can be this number or less.
 * @returns The function returns the number unchanged.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` for a value that is not a
 * whole number from `low` to `high`.
 * @internal
 */
export function wholeNumberOption(value: unknown, name: string, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) {
    throw invalidOption(`Set ${name} to a whole number from ${low} to ${high}, and your code passed ${String(value)}.`)
  }
  return value
}

/**
 * Returns a boolean option, or its default when you left the option out.
 *
 * @param value - The middleware passes the value of the option.
 * @param name - The middleware passes the name of the option for the message of the error.
 * @param fallback - The middleware passes the default of the option.
 * @returns The function returns the boolean.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` for a value other than a
 * boolean or `undefined`.
 * @internal
 */
export function booleanOption(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalidOption(`Set ${name} to true or false.`)
  return value
}

/**
 * Returns a list of strings that you passed as an option.
 *
 * @param value - The middleware passes the value of the option.
 * @param name - The middleware passes the name of the option for the message of the error.
 * @returns The function returns a copy of the list, or `undefined` when you left the option out.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` for a value that is not a
 * list of strings.
 * @internal
 */
export function stringListOption(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
    throw invalidOption(`Set ${name} to a list of strings.`)
  }
  return [...value]
}

/**
 * Returns a fixed response header after checking its name and its value, with the bytes that the
 * package passes to uWebSockets.js.
 *
 * @param name - The middleware passes the name of the header.
 * @param value - The middleware passes the value of the header.
 * @returns The function returns the fixed header.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when the name is not an
 * HTTP token, when the value contains a control character, or when the header is a framing header.
 * @internal
 */
export function fixedHeader(name: string, value: string): FixedHeader {
  let lowerName: string | undefined
  try {
    lowerName = settableHeaderName(name, value)
  } catch (error) {
    throw invalidOption(error instanceof Error ? error.message : String(error))
  }
  if (lowerName === undefined) {
    throw invalidOption(`Leave out the '${name}' header, because the package sets the framing of a response itself.`)
  }
  return { name: lowerName, value, encoded: { name: headerBytes(lowerName), value: headerBytes(value) } }
}
