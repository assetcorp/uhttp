import { expect } from 'vitest'
import { type HttpConnection, requestHead } from './http-client.js'

export const SMUGGLED_REQUEST = 'GET /admin HTTP/1.1\r\nHost: localhost\r\n\r\n'

export function errorBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } })
}

export function tooLarge(limit: number): string {
  return errorBody('PAYLOAD_TOO_LARGE', `The request body is larger than the limit of ${limit} bytes.`)
}

export function piecesOf(bytes: Uint8Array, count: number): Uint8Array[] {
  const size = Math.ceil(bytes.byteLength / count)
  return Array.from({ length: count }, (_, index) => bytes.subarray(index * size, (index + 1) * size))
}

export async function expectHello(connection: HttpConnection): Promise<void> {
  const response = await connection.exchange(requestHead('GET', '/hello'))
  expect([response.status, response.body.toString()]).toEqual([200, 'Hello'])
}
