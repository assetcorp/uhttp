import { MAX_TIMEOUT_MS } from './constants.js'
import { type ErrorCode, UhttpError } from './errors.js'

/**
 * Returns a limit, such as a number of bytes or of parts, after checking that it is a whole number
 * of zero or more.
 *
 * @param value - The function checks this value.
 * @param code - The function throws an error with this code.
 * @param name - The function puts this option name in the message of the error.
 * @returns The function returns the limit unchanged.
 * @throws {@link UhttpError} with the code that you pass when the limit is not a whole number of zero or more.
 * @internal
 */
export function checkedLimit(value: unknown, code: ErrorCode, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new UhttpError(code, `Set ${name} to a whole number of zero or more, and your code passed ${value}.`)
  }
  return value
}

/**
 * Returns a number once the function has checked that it is a whole number within a range.
 *
 * @param value - The function checks this value.
 * @param code - The function throws an error with this code.
 * @param name - The function puts this option name in the message of the error.
 * @param low - The value can be this number or more.
 * @param high - The value can be this number or less.
 * @returns The function returns the number unchanged.
 * @throws {@link UhttpError} with the code that you pass for a value that is not a whole number from `low` to `high`.
 * @internal
 */
export function checkedWholeNumber(value: unknown, code: ErrorCode, name: string, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) {
    throw new UhttpError(
      code,
      `Set ${name} to a whole number from ${low} to ${high}, and your code passed ${String(value)}.`,
    )
  }
  return value
}

/**
 * Returns a time limit after checking that it is a whole number of milliseconds from 0 to the
 * longest delay that you can pass to `setTimeout`.
 *
 * @param value - The function checks this value.
 * @param code - The function throws an error with this code.
 * @returns The function returns the time limit unchanged, where 0 means no limit.
 * @throws {@link UhttpError} with the code that you pass for any other value.
 * @internal
 */
export function checkedTimeLimit(value: unknown, code: ErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMEOUT_MS) {
    throw new UhttpError(
      code,
      `Set timeoutMs to a whole number of milliseconds from 0 to ${MAX_TIMEOUT_MS}, and your code passed ${value}.`,
    )
  }
  return value
}
