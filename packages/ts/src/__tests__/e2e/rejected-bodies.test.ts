import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { bodyApp, KIB, MIB } from '../helpers/apps.js'
import { chunkedRequest, openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import { sendFromNodeClient } from '../helpers/node-client.js'
import {
  CONNECTION_CHOICES,
  errorBody,
  expectClosedAfterReply,
  tooLarge,
  withEveryConnectionChoice,
} from '../helpers/replies.js'
import { pause, start } from '../helpers/server.js'

const TIMEOUT_BODY = errorBody('HANDLER_TIMEOUT', 'The handler took longer than its time limit of 100 ms.')
const COMPRESSED_BODY = errorBody(
  'UNSUPPORTED_MEDIA_TYPE',
  'Send the request body uncompressed, without a Content-Encoding header.',
)

function hangingApp() {
  return createApp({ timeoutMs: 100 })
    .get('/hang', () => new Promise(() => undefined))
    .post('/hang', () => new Promise(() => undefined))
}

describe('request bodies that the package rejects', () => {
  it.each(
    withEveryConnectionChoice([
      { size: '200 bytes', bytes: 200 },
      { size: '5 MiB', bytes: 5 * MIB },
    ]),
  )(
    'answers 413 to a declared body of $size above the limit from $client, and closes the connection without a reset',
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
      await expectClosedAfterReply(connection, response, lines)
    },
  )

  it('answers 413 to the HTTP client of Node.js while it uploads 5 MiB, and the client reads the reply without an error', async () => {
    const server = await start(bodyApp([]))

    const body = Buffer.alloc(5 * MIB, 97)

    const result = await sendFromNodeClient({
      port: server.port,
      path: '/echo',
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': body.byteLength },
      body,
    })

    expect([result.status, result.connectionHeader, result.body.toString(), result.errors]).toEqual([
      413,
      'close',
      tooLarge(100),
      [],
    ])
  })

  it('answers 413 to a client that sends a body above the limit after 100 Continue, and closes the connection without a reset', async () => {
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
    await expectClosedAfterReply(connection, response)
  })

  it.each(
    withEveryConnectionChoice([
      { size: '3 bytes', bytes: 3 },
      { size: '1 MiB', bytes: MIB },
    ]),
  )(
    'answers 415 with Accept-Encoding: identity to a compressed body of $size from $client, and closes the connection without a reset',
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
      await expectClosedAfterReply(connection, response, lines)
    },
  )

  it('answers 415 to a compressed body of length 0, as app.request() does, and closes the connection', async () => {
    const app = bodyApp([])
    const server = await start(app)
    const lines = ['Content-Type: text/plain', 'Content-Length: 0', 'Content-Encoding: gzip']

    const { connection, response } = await send(server.port, requestHead('POST', '/echo', lines))
    const tested = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': '0', 'content-encoding': 'gzip' },
    })

    expect([response.status, tested.status]).toEqual([415, 415])
    expect(await connection.waitForClose()).toBe('closed')
  })

  it('answers 415 when a second Content-Encoding line names a compression after identity, and closes the connection without a reset', async () => {
    const handled: string[] = []
    const server = await start(bodyApp(handled))

    const { connection, response } = await send(
      server.port,
      requestWithBody(
        'POST',
        '/echo',
        ['Content-Type: text/plain', 'Content-Encoding: identity', 'Content-Encoding: gzip'],
        'hello',
      ),
    )

    expect([response.status, response.body.toString()]).toEqual([415, COMPRESSED_BODY])
    expect(handled).toEqual([])
    await expectClosedAfterReply(connection, response)
  })

  it.each(
    withEveryConnectionChoice([
      { size: '12 bytes', count: 2, pieceBytes: 6 },
      { size: '4 MiB', count: 64, pieceBytes: 64 * KIB },
    ]),
  )(
    'answers 413 once a chunked body of $size from $client passes the limit, and closes the connection without a reset',
    async ({ count, pieceBytes, lines }) => {
      const server = await start(bodyApp([], 10))
      const pieces = Array.from({ length: count }, () => Buffer.alloc(pieceBytes, 97))

      const { connection, response } = await send(server.port, chunkedRequest('POST', '/count', lines, pieces))

      expect(response.status).toBe(413)
      expect(response.body.toString()).toBe(tooLarge(10))
      await expectClosedAfterReply(connection, response, lines)
    },
  )

  it('closes the connection after a 413 for a chunked body that ended before the handler read it', async () => {
    const app = createApp({ maxBodyBytes: 10 }).post('/late', async c => {
      await pause(50)
      return c.text(await c.req.body.text())
    })
    const server = await start(app)

    const { connection, response } = await send(
      server.port,
      chunkedRequest('POST', '/late', ['Content-Type: text/plain'], [Buffer.alloc(12, 97)]),
    )

    expect([response.status, response.body.toString()]).toEqual([413, tooLarge(10)])
    await expectClosedAfterReply(connection, response)
  })

  it('closes the connection after a 413 for a form with more than 1,000 parameters, whose whole body the package read', async () => {
    const app = createApp().post('/form', async c => {
      await c.req.body.form()
      return c.text('stored')
    })
    const server = await start(app)
    const form = Array.from({ length: 1_001 }, (_, index) => `field${index}=1`).join('&')

    const { connection, response } = await send(
      server.port,
      requestWithBody('POST', '/form', ['Content-Type: application/x-www-form-urlencoded'], form),
    )

    expect([response.status, response.body.toString()]).toEqual([
      413,
      errorBody('PAYLOAD_TOO_LARGE', 'The form has more than 1000 parameters.'),
    ])
    await expectClosedAfterReply(connection, response)
  })

  it('answers 503 with HANDLER_TIMEOUT once the time limit passes, and then closes the connection itself', async () => {
    const server = await start(hangingApp())
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', '/hang'))

    expect(response.status).toBe(503)
    expect(response.headers.get('connection')).toEqual(['close'])
    expect(response.body.toString()).toBe(TIMEOUT_BODY)
    expect(await connection.waitForClose()).toBe('closed')
  })

  it.each(CONNECTION_CHOICES)(
    'answers 503 to %s that is still uploading when the time limit passes, and closes the connection without a reset',
    async (_client, lines) => {
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
      await expectClosedAfterReply(connection, response, lines)
    },
  )
})
