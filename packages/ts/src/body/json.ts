import { UhttpError } from '../errors.js'

const SUSPECT_PROTO_KEY =
  /"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:/
const SUSPECT_CONSTRUCTOR_KEY =
  /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/

function invalidJson(message: string, cause?: unknown): UhttpError {
  return new UhttpError('INVALID_JSON', message, cause === undefined ? undefined : { cause })
}

function isPoisoned(node: object): boolean {
  if (Object.hasOwn(node, '__proto__')) return true
  if (!Object.hasOwn(node, 'constructor')) return false
  const constructorValue: unknown = Reflect.get(node, 'constructor')
  return (
    typeof constructorValue === 'object' && constructorValue !== null && Object.hasOwn(constructorValue, 'prototype')
  )
}

function checkPrototypeKeys(root: unknown): void {
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (typeof node !== 'object' || node === null) continue
    if (isPoisoned(node)) {
      throw invalidJson('The JSON body contains a __proto__ key, or a constructor key with a prototype key.')
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) pending.push(value)
    }
  }
}

/**
 * Returns the value of a JSON text. The function throws for a `__proto__` key and for a
 * `constructor` key whose value has a `prototype` key, at any depth. It scans the parsed value
 * only when a regular expression matches such a key in the text.
 *
 * @param text - The package passes the decoded body.
 * @returns The function returns the parsed value.
 * @throws {@link UhttpError} with the code `INVALID_JSON` when `JSON.parse` can't parse the text, or
 * when the text contains one of those keys.
 * @internal
 */
export function parseJson(text: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw invalidJson('The request body is not valid JSON.', error)
  }
  if (SUSPECT_PROTO_KEY.test(text) || SUSPECT_CONSTRUCTOR_KEY.test(text)) checkPrototypeKeys(value)
  return value
}
