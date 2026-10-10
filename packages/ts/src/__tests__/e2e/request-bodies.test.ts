import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { chunkedRequest, openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import { errorBody, expectHello, piecesOf, SMUGGLED_REQUEST, tooLarge } from '../helpers/replies.js'
import { pause, start } from '../helpers/server.js'

const MIB = 1_048_576
const TIMEOUT_BODY = errorBody('HANDLER_TIMEOUT', 'The handler took longer than its time limit of 100 ms.')

function bodyApp(handled: string[], maxBodyBytes = 100) {
  return createApp({ maxBodyBytes })
    .get('/hello', c => c.text('Hello'))
    .get('/admin', c => {
      handled.push('admin')
      return c.text('admin')
    })
    .post('/echo', async c => {
      handled.push('echo')
      return c.text(await c.req.body.text())
    })
    .post('/count', async c => {
      handled.push('count')
      let total = 0
      for await (const chunk of c.req.body.stream()) total += chunk.byteLength
      return c.text(String(total))
    })
    .post('/ignore', { maxBodyBytes: 4 * MIB }, c => {
      handled.push('ignore')
      return c.text('ok')
    })
}

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
})

describe('request bodies that the package rejects', () => {
  it.each([
    ['200 bytes', 200],
    ['5 MiB', 5 * MIB],
  ])(
    'answers 413 after the client sends a declared body of %s above the limit, and then closes the connection',
    async (_name, size) => {
      const handled: string[] = []
      const server = await start(bodyApp(handled))

      const { connection, response } = await send(
        server.port,
        requestWithBody('POST', '/echo', ['Content-Type: text/plain'], Buffer.alloc(size, 97)),
      )

      expect(response.status).toBe(413)
      expect(response.headers.get('connection')).toEqual(['close'])
      expect(response.headers.get('content-type')).toEqual(['application/json'])
      expect(response.body.toString()).toBe(tooLarge(100))
      expect(handled).toEqual([])
      expect(await connection.waitForClose()).toBe('closed')
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

  it('answers 413 to a client that sends a body above the limit after 100 Continue, and then closes the connection', async () => {
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
    expect(await connection.waitForClose()).toBe('closed')
  })

  it.each([
    ['3 bytes', 3],
    ['1 MiB', MIB],
  ])(
    'answers 415 with Accept-Encoding: identity after the client sends a compressed body of %s, and then closes the connection',
    async (_name, size) => {
      const handled: string[] = []
      const server = await start(bodyApp(handled, 2 * MIB))

      const { connection, response } = await send(
        server.port,
        requestWithBody('POST', '/echo', ['Content-Type: text/plain', 'Content-Encoding: br'], Buffer.alloc(size, 97)),
      )

      expect(response.status).toBe(415)
      expect(response.headers.get('accept-encoding')).toEqual(['identity'])
      expect(response.headers.get('connection')).toEqual(['close'])
      expect(response.body.toString()).toBe(
        errorBody('UNSUPPORTED_MEDIA_TYPE', 'Send the request body uncompressed, without a Content-Encoding header.'),
      )
      expect(handled).toEqual([])
      expect(await connection.waitForClose()).toBe('closed')
    },
  )

  it.each([
    ['12 bytes', 2, 6],
    ['4 MiB', 64, 64 * 1024],
  ])(
    'answers 413 once a chunked body of %s passes the limit, after the client sends it, and then closes the connection',
    async (_name, count, size) => {
      const server = await start(bodyApp([], 10))
      const pieces = Array.from({ length: count }, () => Buffer.alloc(size, 97))

      const { connection, response } = await send(server.port, chunkedRequest('POST', '/count', [], pieces))

      expect(response.status).toBe(413)
      expect(response.headers.get('connection')).toEqual(['close'])
      expect(response.body.toString()).toBe(tooLarge(10))
      expect(await connection.waitForClose()).toBe('closed')
    },
  )

  it('answers 503 with HANDLER_TIMEOUT once the time limit passes, and then closes the connection', async () => {
    const server = await start(createApp({ timeoutMs: 100 }).get('/hang', () => new Promise(() => undefined)))

    const { connection, response } = await send(server.port, requestHead('GET', '/hang'))

    expect(response.status).toBe(503)
    expect(response.headers.get('connection')).toEqual(['close'])
    expect(response.body.toString()).toBe(TIMEOUT_BODY)
    expect(await connection.waitForClose()).toBe('closed')
  })

  it('answers 503 to a client that is still uploading when the time limit passes, and then closes the connection', async () => {
    const server = await start(createApp({ timeoutMs: 100 }).post('/hang', () => new Promise(() => undefined)))
    const connection = await openConnection(server.port)

    void connection.write(requestHead('POST', '/hang', ['Content-Length: 50']))
    for (let index = 0; index < 10; index++) {
      void connection.write('12345')
      await pause(40)
    }
    const response = await connection.response()

    expect(response.status).toBe(503)
    expect(response.body.toString()).toBe(TIMEOUT_BODY)
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
