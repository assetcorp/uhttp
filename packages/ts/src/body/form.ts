import { MAX_FORM_FIELDS } from '../constants.js'
import { UhttpError } from '../errors.js'

const PERCENT = 0x25
const PLUS = /\+/g
const HEX_DIGIT = /^[0-9A-Fa-f]{2}$/
const decoder = new TextDecoder()

/**
 * `form()` and `multipart()` return the fields of a form in this shape, which maps each name to its
 * value, or to a list of values when the form repeats the name. The map has no prototype, so a
 * field named `__proto__` is an ordinary entry.
 */
export type FormFields = Record<string, string | string[]>

/**
 * Adds one value to the fields of a form, and turns the entry into a list when the name repeats.
 *
 * @param fields - The function adds the value to these fields.
 * @param name - The client sent this name.
 * @param value - The client sent this value.
 * @internal
 */
export function addField(fields: FormFields, name: string, value: string): void {
  const earlier = fields[name]
  if (earlier === undefined) fields[name] = value
  else if (typeof earlier === 'string') fields[name] = [earlier, value]
  else earlier.push(value)
}

function percentDecodeLeniently(text: string): string {
  const bytes = Buffer.from(text)
  const output = new Uint8Array(bytes.byteLength)
  let length = 0
  for (let index = 0; index < bytes.byteLength; index++) {
    const byte = bytes[index] ?? 0
    const hex = byte === PERCENT ? bytes.subarray(index + 1, index + 3).toString('latin1') : ''
    if (HEX_DIGIT.test(hex)) {
      output[length++] = Number.parseInt(hex, 16)
      index += 2
      continue
    }
    output[length++] = byte
  }
  return decoder.decode(output.subarray(0, length))
}

function decodeComponent(text: string): string {
  const spaced = text.includes('+') ? text.replace(PLUS, ' ') : text
  if (!spaced.includes('%')) return spaced
  try {
    return decodeURIComponent(spaced)
  } catch {
    return percentDecodeLeniently(spaced)
  }
}

/**
 * Returns the fields of a URL-encoded body, decoded as the WHATWG URL standard decodes them, with
 * no bracket or dot nesting. The function counts the parameters as it parses them.
 *
 * @param text - The package passes the decoded body.
 * @returns The function returns the fields in a map with no prototype.
 * @throws {@link UhttpError} with the code `PAYLOAD_TOO_LARGE` once the body passes 1,000 parameters.
 * @internal
 */
export function parseForm(text: string): FormFields {
  const fields: FormFields = Object.create(null)
  let count = 0
  let start = 0
  while (start <= text.length) {
    const ampersand = text.indexOf('&', start)
    const end = ampersand === -1 ? text.length : ampersand
    if (end > start) {
      count++
      if (count > MAX_FORM_FIELDS) {
        throw new UhttpError('PAYLOAD_TOO_LARGE', `The form has more than ${MAX_FORM_FIELDS} parameters.`)
      }
      const pair = text.slice(start, end)
      const equals = pair.indexOf('=')
      const name = equals === -1 ? pair : pair.slice(0, equals)
      const value = equals === -1 ? '' : pair.slice(equals + 1)
      addField(fields, decodeComponent(name), decodeComponent(value))
    }
    start = end + 1
  }
  return fields
}
