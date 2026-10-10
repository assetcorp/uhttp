import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { bodyApp } from '../helpers/apps.js'
import { chunkedRequest, openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import { expectHello, piecesOf, SMUGGLED_REQUEST } from '../helpers/replies.js'
import { pause, start } from '../helpers/server.js'

const MIB = 1_048_576

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

  it.each([
    ['a few bytes', 0],
    ['1 MiB', MIB],
  ])(
    'answers a handler that leaves a body of %s unread, and runs no request hidden in that body',
    async (_name, padding) => {
      const handled: string[] = []
      const server = await start(bodyApp(handled))
      const body = Buffer.concat([Buffer.from(SMUGGLED_REQUEST), Buffer.alloc(padding, 97)])
      const connection = await openConnection(server.port)

      void connection.write(
        Buffer.concat([requestWithBody('POST', '/ignore', [], body), Buffer.from(requestHead('GET', '/hello'))]),
      )
      const ignored = await connection.response()
      const next = await connection.response()

      expect([ignored.status, ignored.body.toString()]).toEqual([200, 'ok'])
      expect([next.status, next.body.toString()]).toEqual([200, 'Hello'])
      expect(handled).toEqual(['ignore'])
    },
  )

  it('answers a handler that replies while the client still uploads, and keeps the connection open', async () => {
    const server = await start(bodyApp([]))
    const body = Buffer.alloc(40 * 64 * 1024, 97)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('POST', '/ignore', [`Content-Length: ${body.byteLength}`]))
    for (const piece of piecesOf(body, 40)) {
      await connection.write(piece)
      await pause(5)
    }
    const response = await connection.response()

    expect([response.status, response.body.toString()]).toEqual([200, 'ok'])
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('answers a handler that leaves a 2 MiB body unread after the whole body, and then closes cleanly, when the client sent Connection: close', async () => {
    const server = await start(bodyApp([]))
    const body = Buffer.alloc(2 * MIB, 97)

    const { connection, response } = await send(
      server.port,
      requestWithBody('POST', '/ignore', ['Connection: close'], body),
    )

    expect([response.status, response.body.toString()]).toEqual([200, 'ok'])
    expect(await connection.waitForClose()).toBe('closed')
  })

  it('sends a large streamed reply to a POST whose handler leaves a large body unread, and keeps the connection open', async () => {
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
    await expectHello(connection)
  }, 15_000)
})
