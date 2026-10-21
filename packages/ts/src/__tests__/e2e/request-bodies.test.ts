import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp, UhttpError } from '../../index.js'
import { bodyApp, KIB, MIB } from '../helpers/apps.js'
import {
  chunkedRequest,
  chunkFrame,
  openConnection,
  requestHead,
  requestWithBody,
  send,
} from '../helpers/http-client.js'
import {
  expectClosedAfterReply,
  expectHello,
  piecesOf,
  SMUGGLED_REQUEST,
  tooLarge,
  withEveryConnectionChoice,
} from '../helpers/replies.js'
import { pause, start } from '../helpers/server.js'

describe('request bodies over the network', () => {
  it('reads a JSON body that arrives in pieces while middleware awaits, and keeps the connection open', async () => {
    const server = await start(
      createApp()
        .use(async (_c, next) => {
          await pause(50)
          await next()
        })
        .post('/users', async c => c.json(await c.req.body.json()))
        .get('/hello', c => c.text('Hello')),
    )
    const payload = Buffer.from(JSON.stringify({ name: 'Ama', notes: 'n'.repeat(200_000) }))
    const connection = await openConnection(server.port)

    void connection.write(
      requestHead('POST', '/users', ['Content-Type: application/json', `Content-Length: ${payload.byteLength}`]),
    )
    for (const piece of piecesOf(payload, 4)) {
      await pause(20)
      void connection.write(piece)
    }
    const response = await connection.response()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toEqual(['application/json'])
    expect(response.body.equals(payload)).toBe(true)
    await expectHello(connection)
  })

  it('reads a 512 KiB body that arrives in pieces while the handler waits on bytes(), and keeps the connection open', async () => {
    const server = await start(
      createApp()
        .post('/digest', async c => {
          const bytes = await c.req.body.bytes()
          return c.json({ length: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
        })
        .get('/hello', c => c.text('Hello')),
    )
    const payload = randomBytes(512 * KIB)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('POST', '/digest', [`Content-Length: ${payload.byteLength}`]))
    for (const piece of piecesOf(payload, 16)) {
      await connection.write(piece)
      await pause(5)
    }
    const response = await connection.response()

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body.toString())).toEqual({
      length: payload.byteLength,
      sha256: createHash('sha256').update(payload).digest('hex'),
    })
    await expectHello(connection)
  })

  it('fails bytes() with REQUEST_ABORTED when the client goes in the middle of the body, and serves the next client', async () => {
    const failure = Promise.withResolvers<unknown>()
    const server = await start(
      createApp()
        .post('/upload', async c => {
          try {
            await c.req.body.bytes()
          } catch (error) {
            failure.resolve(error instanceof UhttpError ? error.code : error)
            throw error
          }
          return c.text('read')
        })
        .get('/hello', c => c.text('Hello')),
    )
    const leaving = await openConnection(server.port)

    await leaving.write(requestHead('POST', '/upload', [`Content-Length: ${256 * KIB}`]))
    await leaving.write(Buffer.alloc(64 * KIB, 97))
    await pause(20)
    leaving.destroy()

    expect(await failure.promise).toBe('REQUEST_ABORTED')
    await expectHello(await openConnection(server.port))
  })

  it('answers 413 to a chunked body that passes the limit while the handler waits on bytes(), and closes the connection', async () => {
    const handled: string[] = []
    const server = await start(
      createApp({ maxBodyBytes: 100 }).post('/upload', async c => {
        const bytes = await c.req.body.bytes()
        handled.push(String(bytes.byteLength))
        return c.text('read')
      }),
    )
    const connection = await openConnection(server.port)

    void connection.write(requestHead('POST', '/upload', ['Transfer-Encoding: chunked']))
    for (let piece = 0; piece < 3; piece++) {
      await connection.write(chunkFrame(Buffer.alloc(40, 97)))
      await pause(10)
    }
    const response = await connection.response()

    expect([response.status, response.body.toString()]).toEqual([413, tooLarge(100)])
    expect(handled).toEqual([])
    await expectClosedAfterReply(connection, response)
  })

  it('reads an empty body from a POST with no length and no chunked encoding', async () => {
    const server = await start(
      createApp()
        .post('/empty', async c => c.text(`[${await c.req.body.text()}]`))
        .get('/hello', c => c.text('Hello')),
    )
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('POST', '/empty', ['Content-Type: text/plain']))

    expect([response.status, response.body.toString()]).toEqual([200, '[]'])
    await expectHello(connection)
  })

  it('sends 100 Continue to a client that expects it, and then reads the body', async () => {
    const server = await start(bodyApp([]))
    const connection = await openConnection(server.port)

    void connection.write(
      requestHead('POST', '/echo', ['Content-Type: text/plain', 'Content-Length: 5', 'Expect: 100-continue']),
    )
    const interim = await connection.interim()
    const response = await connection.exchange('hello')

    expect(interim).toBe(100)
    expect([response.status, response.body.toString()]).toEqual([200, 'hello'])
    await expectHello(connection)
  })

  it('counts a chunked body as it arrives, and keeps the connection open', async () => {
    const server = await start(bodyApp([]))
    const connection = await openConnection(server.port)

    const response = await connection.exchange(chunkedRequest('POST', '/count', [], ['123456', '789012']))

    expect([response.status, response.body.toString()]).toEqual([200, '12'])
    await expectHello(connection)
  })

  it('discards a body of a few bytes that a handler leaves unread, runs no request hidden in it, and answers the next request', async () => {
    const handled: string[] = []
    const server = await start(bodyApp(handled))
    const body = Buffer.from(SMUGGLED_REQUEST)
    const connection = await openConnection(server.port)

    void connection.write(
      Buffer.concat([requestWithBody('POST', '/ignore', [], body), Buffer.from(requestHead('GET', '/hello'))]),
    )
    const ignored = await connection.response()
    const next = await connection.response()

    expect([ignored.status, ignored.body.toString()]).toEqual([200, 'ok'])
    expect(ignored.headers.has('connection')).toBe(false)
    expect([next.status, next.body.toString()]).toEqual([200, 'Hello'])
    expect(handled).toEqual(['ignore'])
  })

  it('closes the connection after a reply that leaves 1 MiB unread, and runs no request hidden in that body or sent after it', async () => {
    const handled: string[] = []
    const server = await start(bodyApp(handled))
    const body = Buffer.concat([Buffer.from(SMUGGLED_REQUEST), Buffer.alloc(MIB, 97)])
    const connection = await openConnection(server.port)

    void connection.write(
      Buffer.concat([requestWithBody('POST', '/ignore', [], body), Buffer.from(requestHead('GET', '/hello'))]),
    )
    const ignored = await connection.response()

    expect([ignored.status, ignored.body.toString()]).toEqual([200, 'ok'])
    expect(ignored.headers.get('connection')).toEqual(['close'])
    expect(await connection.waitForClose()).toBe('closed')
    expect(handled).toEqual(['ignore'])
  })

  it('answers a handler that replies while the client still uploads 200 KiB, and keeps the connection open', async () => {
    const server = await start(bodyApp([]))
    const body = Buffer.alloc(200 * 1024, 97)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('POST', '/ignore', [`Content-Length: ${body.byteLength}`]))
    for (const piece of piecesOf(body, 20)) {
      await connection.write(piece)
      await pause(5)
    }
    const response = await connection.response()

    expect([response.status, response.body.toString()]).toEqual([200, 'ok'])
    expect(response.headers.has('connection')).toBe(false)
    await expectHello(connection)
  })

  it.each(
    withEveryConnectionChoice([
      { size: '2.5 MiB', bytes: 40 * 64 * KIB },
      { size: '300 KiB', bytes: 300 * 1024 },
    ]),
  )(
    'answers a handler that replies while $client still uploads $size, and closes the connection without a reset',
    async ({ bytes, lines }) => {
      const server = await start(bodyApp([]))
      const body = Buffer.alloc(bytes, 97)
      const connection = await openConnection(server.port)

      void connection.write(requestHead('POST', '/ignore', [`Content-Length: ${body.byteLength}`, ...lines]))
      const response = await connection.response()
      for (const piece of piecesOf(body, 20)) {
        await connection.write(piece)
        await pause(5)
      }

      expect([response.status, response.body.toString()]).toEqual([200, 'ok'])
      expect(response.framing).toBe('chunked')
      await expectClosedAfterReply(connection, response, lines)
    },
  )

  it('sends a large streamed reply with Connection: close to a POST whose handler leaves 4 MiB unread, and closes the connection without a reset', async () => {
    const replyBytes = 8 * MIB
    const server = await start(
      createApp()
        .post('/report', { maxBodyBytes: 16 * MIB }, c =>
          c.stream(
            async stream => {
              for (let sent = 0; sent < replyBytes; sent += MIB) await stream.write(new Uint8Array(MIB).fill(65))
            },
            { length: replyBytes },
          ),
        )
        .get('/hello', c => c.text('Hello')),
    )

    const { connection, response } = await send(
      server.port,
      requestWithBody('POST', '/report', [], Buffer.alloc(4 * MIB)),
      { waitMs: 10_000 },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toEqual([String(replyBytes)])
    expect(response.body.equals(Buffer.alloc(replyBytes, 65))).toBe(true)
    await expectClosedAfterReply(connection, response)
  }, 15_000)

  it.each([
    { size: '200 KiB', bytes: 200 * KIB, connection: undefined },
    { size: '1 MiB', bytes: MIB, connection: ['close'] },
  ])(
    'discards a body of $size sent to a route without a body reader, and closes the connection only above 256 KiB',
    async ({ bytes, connection: expected }) => {
      const handled: string[] = []
      const server = await start(bodyApp(handled))
      const connection = await openConnection(server.port)

      void connection.write(requestHead('DELETE', '/missing', [`Content-Length: ${bytes}`]))
      const response = await connection.response()
      for (const piece of piecesOf(Buffer.alloc(bytes, 97), 20)) {
        await connection.write(piece)
        await pause(5)
      }

      expect([response.status, response.headers.get('connection')]).toEqual([404, expected])
      if (expected === undefined) await expectHello(connection)
      else await expectClosedAfterReply(connection, response)
    },
  )
})
