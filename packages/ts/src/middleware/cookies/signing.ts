import { createHmac, createSecretKey, type KeyObject, timingSafeEqual } from 'node:crypto'
import { invalidOption } from '../options.js'
import { COOKIE_SIGNATURE_BYTES, COOKIE_SIGNATURE_HASH, MIN_COOKIE_KEY_BYTES } from './constants.js'

const BASE64URL = /^[A-Za-z0-9_-]+$/

/**
 * Returns the signing keys that you passed to `cookies()`, after checking that each one has at
 * least 20 bytes.
 *
 * @param value - The middleware passes the `keys` option.
 * @returns The function returns one secret key for each entry, or `undefined` when you passed none.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` for an empty list, an entry
 * that is neither a string nor bytes, or a key shorter than 20 bytes.
 * @internal
 */
export function signingKeys(value: unknown): readonly KeyObject[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidOption('Set the keys option of cookies() to a list of one or more keys.')
  }
  return value.map(entry => {
    const bytes = typeof entry === 'string' ? Buffer.from(entry) : entry instanceof Uint8Array ? entry : undefined
    if (bytes === undefined || bytes.byteLength < MIN_COOKIE_KEY_BYTES) {
      throw invalidOption(
        `Make each key of cookies() a string or bytes of at least ${MIN_COOKIE_KEY_BYTES} bytes, so that nobody can guess it.`,
      )
    }
    return createSecretKey(bytes)
  })
}

function signatureOf(key: KeyObject, name: string, value: string): Buffer {
  return createHmac(COOKIE_SIGNATURE_HASH, key).update(`${name}=${value}`).digest()
}

/**
 * Returns the value of a cookie with its signature, which is the base64url HMAC-SHA-256 of the
 * name, `=`, and the value under the first key.
 *
 * @param keys - The caller passes the signing keys.
 * @param name - The caller passes the name of the cookie.
 * @param value - The caller passes the value to sign.
 * @returns The function returns the value, a dot, and the signature.
 * @internal
 */
export function signedValue(keys: readonly KeyObject[], name: string, value: string): string {
  const [first] = keys
  if (first === undefined) return value
  return `${value}.${signatureOf(first, name, value).toString('base64url')}`
}

/**
 * Returns the value of a signed cookie when the function can verify its signature with one of the
 * keys.
 *
 * @param keys - The caller passes the signing keys.
 * @param name - The caller passes the name of the cookie.
 * @param signed - The caller passes the value of the cookie with its signature.
 * @returns The function returns the value without the signature, or `undefined` when the function
 * can verify the signature with none of the keys.
 * @internal
 */
export function verifiedValue(keys: readonly KeyObject[], name: string, signed: string): string | undefined {
  const dot = signed.lastIndexOf('.')
  if (dot === -1) return undefined
  const encoded = signed.slice(dot + 1)
  if (!BASE64URL.test(encoded)) return undefined
  const given = Buffer.from(encoded, 'base64url')
  if (given.byteLength !== COOKIE_SIGNATURE_BYTES) return undefined
  const value = signed.slice(0, dot)
  let verified = false
  for (const key of keys) {
    if (timingSafeEqual(given, signatureOf(key, name, value))) verified = true
  }
  return verified ? value : undefined
}
