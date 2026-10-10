import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { bodyApp } from '../helpers/apps.js'
import { chunkedRequest, openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import {
  CONNECTION_CHOICES,
  errorBody,
  expectConnectionAfterReply,
  expectHello,
  tooLarge,
  withEveryConnectionChoice,
} from '../helpers/replies.js'
import { pause, start } from '../helpers/server.js'

const MIB = 1_048_576
const TIMEOUT_BODY = errorBody('HANDLER_TIMEOUT', 'The handler took longer than its time limit of 100 ms.')
const COMPRESSED_BODY = errorBody(
  'UNSUPPORTED_MEDIA_TYPE',
  'Send the request body uncompressed, without a Content-Encoding header.',
)

function hangingApp() {
  return createApp({ timeoutMs: 100 })
    .get('/hang', () => new Promise(() => undefined))
    .post('/hang', () => new Promise(() => undefined))
    .get('/hello', c => c.text('Hello'))
}

describe('request bodies that the package rejects', () => {
  it.each(
    withEveryConnectionChoice([
      { size: '200 bytes', bytes: 200 },
      { size: '5 MiB', bytes: 5 * MIB },
    ]),
  )(
    'answers 413 to a declared body of $size above the limit after the client sends it, and $choice',
    async ({ bytes, lines }) => {
      const handled: string[] = []
      const server = await start(bodyApp(handled))

      const { connection, response } = await send(
        server.port,
        requestWithBody('POST', '/echo', ['Content-Type: text/plain', ...lines], Buffer.alloc(bytes, 97)),
      )

      expect(response.status).toBe(413)
      expect(response.headers.get('content-type')).toEqual(['application/json'])
      expect(response.body.toString()).toBe(tooLarge(100))
      expect(handled).toEqual([])
      await expectConnectionAfterReply(connection, lines)
    },
  )

  it('answers 413 to fetch after it sends a body above the limit', async () => {
    const server = await start(bodyApp([]))

    const response = await fetch(`http://127.0.0.1:${server.port}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.alloc(5 * MIB, 97),
    })

    expect(response.status).toBe(413)
    expect(await response.text()).toBe(tooLarge(100))
  })

  it('answers 413 to a client that sends a body above the limit after 100 Continue, and keeps the connection open', async () => {
    const server = await start(bodyApp([]))
    const connection = await openConnection(server.port)
    const body = Buffer.alloc(5_000, 97)

    void connection.write(
      requestHead('POST', '/echo', [
        'Content-Type: text/plain',
        `Content-Length: ${body.byteLength}`,
        'Expect: 100-continue',
      ]),
    )
    if ((await connection.interim()) === 100) void connection.write(body)
    const response = await connection.response()

    expect(response.status).toBe(413)
    expect(response.body.toString()).toBe(tooLarge(100))
    await expectHello(connection)
  })

  it.each(
    withEveryConnectionChoice([
      { size: '3 bytes', bytes: 3 },
      { size: '1 MiB', bytes: MIB },
    ]),
  )(
    'answers 415 with Accept-Encoding: identity to a compressed body of $size after the client sends it, and $choice',
    async ({ bytes, lines }) => {
      const handled: string[] = []
      const server = await start(bodyApp(handled, 2 * MIB))

      const { connection, response } = await send(
        server.port,
        requestWithBody(
          'POST',
          '/echo',
          ['Content-Type: text/plain', 'Content-Encoding: br', ...lines],
          Buffer.alloc(bytes, 97),
        ),
      )

      expect(response.status).toBe(415)
      expect(response.headers.get('accept-encoding')).toEqual(['identity'])
      expect(response.body.toString()).toBe(COMPRESSED_BODY)
      expect(handled).toEqual([])
      await expectConnectionAfterReply(connection, lines)
    },
  )

  it.each(
    withEveryConnectionChoice([
      { size: '12 bytes', count: 2, pieceBytes: 6 },
      { size: '4 MiB', count: 64, pieceBytes: 64 * 1024 },
    ]),
  )(
    'answers 413 once a chunked body of $size passes the limit, after the client sends it, and $choice',
    async ({ count, pieceBytes, lines }) => {
      const server = await start(bodyApp([], 10))
      const pieces = Array.from({ length: count }, () => Buffer.alloc(pieceBytes, 97))

      const { connection, response } = await send(server.port, chunkedRequest('POST', '/count', lines, pieces))

      expect(response.status).toBe(413)
      expect(response.body.toString()).toBe(tooLarge(10))
      await expectConnectionAfterReply(connection, lines)
    },
  )

  it('answers 503 with HANDLER_TIMEOUT once the time limit passes, and keeps the connection open', async () => {
    const server = await start(hangingApp())
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', '/hang'))

    expect(response.status).toBe(503)
    expect(response.headers.has('connection')).toBe(false)
    expect(response.body.toString()).toBe(TIMEOUT_BODY)
    await expectHello(connection)
  })

  it.each(CONNECTION_CHOICES)(
    'answers 503 to a client that is still uploading when the time limit passes, and %s',
    async (_choice, lines) => {
      const server = await start(hangingApp())
      const connection = await openConnection(server.port)

      void connection.write(requestHead('POST', '/hang', ['Content-Length: 50', ...lines]))
      for (let index = 0; index < 10; index++) {
        void connection.write('12345')
        await pause(40)
      }
      const response = await connection.response()

      expect(response.status).toBe(503)
      expect(response.body.toString()).toBe(TIMEOUT_BODY)
      await expectConnectionAfterReply(connection, lines)
    },
  )
})
