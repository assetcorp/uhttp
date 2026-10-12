import { Agent } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { KIB, MIB } from '../helpers/apps.js'
import { chunkFrame, openConnection, requestHead, send } from '../helpers/http-client.js'
import { sendFromNodeClient } from '../helpers/node-client.js'
import { errorBody, expectClosedAfterReply, expectHello, withEveryConnectionChoice } from '../helpers/replies.js'
import { memoryLogger, pause, start } from '../helpers/server.js'

const CHUNK_BYTES = MIB
const CHUNK_COUNT = 32
const TOTAL_BYTES = CHUNK_BYTES * CHUNK_COUNT
const INTERNAL_ERROR = errorBody('INTERNAL_ERROR', 'The request failed.')

interface Progress {
  written: number
  done: boolean
}

function largeStreamApp(length: number | undefined, progress: Progress) {
  return createApp()
    .get('/large', c =>
      c.stream(
        async stream => {
          const chunk = new Uint8Array(CHUNK_BYTES).fill(97)
          for (let index = 0; index < CHUNK_COUNT; index++) {
            await stream.write(chunk)
            progress.written++
          }
          progress.done = true
        },
        length === undefined ? {} : { length },
      ),
    )
    .get('/hello', c => c.text('Hello'))
}

describe('streamed replies over the network', () => {
  it.each([
    ['unknown length', undefined, 'chunked'],
    ['known length', TOTAL_BYTES, 'length'],
  ])(
    'holds the producer while the client reads slowly, then delivers every byte of a body of %s',
    async (_name, length, framing) => {
      const progress = { written: 0, done: false }
      const server = await start(largeStreamApp(length, progress))
      const connection = await openConnection(server.port)

      connection.pauseReading()
      void connection.write(requestHead('GET', '/large'))
      await pause(300)
      const writtenWhileHeld = progress.written
      connection.resumeReading()
      const response = await connection.response({ waitMs: 10_000 })

      expect(writtenWhileHeld).toBeLessThan(CHUNK_COUNT)
      expect(progress.done).toBe(true)
      expect(response.status).toBe(200)
      expect(response.framing).toBe(framing)
      expect(response.body.equals(Buffer.alloc(TOTAL_BYTES, 97))).toBe(true)
      await expectHello(connection)
    },
    15_000,
  )

  it('delivers the whole body of known length to the HTTP client of Node.js, which then reuses the connection', async () => {
    const server = await start(largeStreamApp(TOTAL_BYTES, { written: 0, done: false }))
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })

    try {
      const large = await sendFromNodeClient({ port: server.port, path: '/large', agent })
      const hello = await sendFromNodeClient({ port: server.port, path: '/hello', agent })

      expect([large.status, large.contentLength, large.errors]).toEqual([200, String(TOTAL_BYTES), []])
      expect(large.body.equals(Buffer.alloc(TOTAL_BYTES, 97))).toBe(true)
      expect([hello.body.toString(), hello.reusedSocket, hello.errors]).toEqual(['Hello', true, []])
    } finally {
      agent.destroy()
    }
  })

  it('sends a chunked body with the headers that middleware added after the chain returned, and keeps the connection open', async () => {
    const app = createApp()
      .use(async (c, next) => {
        await next()
        c.header('x-after', 'yes')
      })
      .get('/words', c =>
        c.stream(
          async stream => {
            await stream.write('one ')
            await stream.write('two')
          },
          { contentType: 'text/plain' },
        ),
      )
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', '/words'))

    expect(response.headers.get('x-after')).toEqual(['yes'])
    expect(response.headers.get('content-type')).toEqual(['text/plain'])
    expect(response.framing).toBe('chunked')
    expect(response.body.toString()).toBe('one two')
    await expectHello(connection)
  })

  it.each([
    ['/chunked', 'the upstream closed'],
    ['/sized', 'INVALID_STREAM'],
  ])(
    'closes the connection before the end of the body when the producer of %s fails part of the way through',
    async (path, logged) => {
      const { entries, logger } = memoryLogger()
      const app = createApp({ logger })
        .get('/chunked', c =>
          c.stream(async stream => {
            await stream.write('partial')
            await pause(10)
            throw new Error('the upstream closed')
          }),
        )
        .get('/sized', c =>
          c.stream(
            async stream => {
              await stream.write('par')
            },
            { length: 10 },
          ),
        )
      const server = await start(app)
      const connection = await openConnection(server.port)

      await expect(connection.exchange(requestHead('GET', path))).rejects.toThrow(/before the response ended/)
      expect(connection.state).toBe('closed')
      const error = entries.map(entry => entry.details.err)[0]
      expect([(error as Error).message, (error as { code?: string }).code]).toContain(logged)
    },
  )

  it('sends the headers and the declared length for HEAD, never calls the producer, and sends no body', async () => {
    let started = false
    const app = createApp()
      .get('/download', c =>
        c.stream(
          async stream => {
            started = true
            await stream.write('abc')
          },
          { length: 3 },
        ),
      )
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('HEAD', '/download') + requestHead('GET', '/hello'))
    const head = await connection.response({ method: 'HEAD' })
    const next = await connection.response()

    expect(head.headers.get('content-length')).toEqual(['3'])
    expect(head.headers.get('content-type')).toEqual(['application/octet-stream'])
    expect([next.status, next.body.toString()]).toEqual([200, 'Hello'])
    expect(started).toBe(false)
  })

  it('sends no length and no body for HEAD to a stream of unknown length, as app.request() does', async () => {
    const app = createApp()
      .get('/feed', c => c.stream(stream => stream.write('entry').then(() => undefined)))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('HEAD', '/feed') + requestHead('GET', '/hello'))
    const head = await connection.response({ method: 'HEAD' })
    const next = await connection.response()
    const tested = await app.request('/feed', { method: 'HEAD' })

    expect(head.status).toBe(200)
    expect(head.headers.has('content-length')).toBe(false)
    expect(head.headers.has('transfer-encoding')).toBe(false)
    expect([next.status, next.body.toString()]).toEqual([200, 'Hello'])
    expect(tested.headers.has('content-length')).toBe(false)
  })

  it('sends a 500 in place of a stream content type with CRLF, so that no header is injected', async () => {
    const app = createApp()
      .get('/report', c =>
        c.stream(stream => stream.write('rows').then(() => undefined), { contentType: 'text/csv\r\nx-injected: yes' }),
      )
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', '/report'))

    expect(response.status).toBe(500)
    expect(response.headers.has('x-injected')).toBe(false)
    expect(response.body.toString()).toBe(INTERNAL_ERROR)
    expect((await app.request('/report')).status).toBe(500)
    await expectHello(connection)
  })

  it('resolves writes to false once the client has gone', async () => {
    const results: boolean[] = []
    const finished = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const app = createApp().get('/endless', c =>
      c.stream(async stream => {
        started.resolve()
        while (results.at(-1) !== false) {
          results.push(await stream.write(new Uint8Array(64 * KIB)))
          await pause(1)
        }
        finished.resolve()
      }),
    )
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('GET', '/endless'))
    await started.promise
    await pause(20)
    connection.destroy()
    await finished.promise

    expect(results.at(-1)).toBe(false)
  })

  it.each(
    withEveryConnectionChoice([
      { name: 'unknown length', length: undefined, framing: 'chunked' },
      { name: 'known length', length: 14, framing: 'length' },
    ]),
  )(
    'sends a whole and valid body of $name with Connection: close while $client still uploads a chunked body, and closes the connection without a reset',
    async ({ length, framing, lines }) => {
      const app = createApp({ maxBodyBytes: 100 })
        .post('/words', c =>
          c.stream(
            async stream => {
              await stream.write('part-1;')
              await pause(50)
              await stream.write('part-2;')
            },
            length === undefined ? {} : { length },
          ),
        )
        .get('/hello', c => c.text('Hello'))
      const server = await start(app)
      const connection = await openConnection(server.port)

      void connection.write(requestHead('POST', '/words', ['Transfer-Encoding: chunked', ...lines]))
      for (let index = 0; index < 8; index++) {
        void connection.write(chunkFrame(Buffer.alloc(64 * KIB, 120)))
        await pause(40)
      }
      void connection.write('0\r\n\r\n')
      const response = await connection.response()

      expect(response.status).toBe(200)
      expect(response.framing).toBe(framing)
      expect(response.body.toString()).toBe('part-1;part-2;')
      await expectClosedAfterReply(connection, response, lines)
    },
  )
})

describe('server-sent events over the network', () => {
  it('sends every event and ends the stream when the producer returns, and keeps the connection open', async () => {
    const app = createApp()
      .get('/events', c =>
        c.sse(async events => {
          await events.send({ event: 'greeting', data: 'hello' })
          await events.send({ id: '7', data: 'two\nlines' })
        }),
      )
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', '/events'))

    expect(response.headers.get('content-type')).toEqual(['text/event-stream'])
    expect(response.headers.get('cache-control')).toEqual(['no-cache'])
    expect(response.framing).toBe('chunked')
    expect(response.body.toString()).toBe('event: greeting\ndata: hello\n\nid: 7\ndata: two\ndata: lines\n\n')
    await expectHello(connection)
  })

  it('splits data at every CR and LF, so that data from a client cannot start a new event or field', async () => {
    const app = createApp()
      .get('/events', c =>
        c.sse(async events => {
          await events.send({ data: 'hello\n\nevent: admin\rdata: injected\r\nid: 9' })
        }),
      )
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(server.port, requestHead('GET', '/events'))

    expect(response.body.toString()).toBe(
      'data: hello\ndata: \ndata: event: admin\ndata: data: injected\ndata: id: 9\n\n',
    )
    await expectHello(connection)
  })

  it('sends events and heartbeats, and stops the heartbeat when the client goes', async () => {
    const closed = Promise.withResolvers<boolean>()
    const app = createApp().get('/events', c =>
      c.sse(
        async events => {
          events.onClose(() => closed.resolve(events.closed))
          await events.send({ event: 'greeting', data: 'hello' })
          await new Promise(() => undefined)
        },
        { heartbeatMs: 20 },
      ),
    )
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('GET', '/events'))
    const received = await connection.chunkedUntil(':\n\n')
    connection.destroy()

    expect(received.headers.get('content-type')).toEqual(['text/event-stream'])
    expect(received.body.startsWith('event: greeting\ndata: hello\n\n:\n\n')).toBe(true)
    expect(await closed.promise).toBe(true)
    expect(connection.state).not.toBe('open')
  })

  it('stops the heartbeat when the producer returns while the client still reads slowly', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    const returned = Promise.withResolvers<void>()
    const app = createApp()
      .get('/events', c =>
        c.sse(
          events => {
            void events.send({ data: 'x'.repeat(CHUNK_BYTES * 16) })
            returned.resolve()
          },
          { heartbeatMs: 10 },
        ),
      )
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)
    connection.pauseReading()
    void connection.write(requestHead('GET', '/events'))

    try {
      await returned.promise
      await pause(150)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
    connection.resumeReading()
    const response = await connection.response({ waitMs: 10_000 })
    expect(response.body.toString().startsWith('data: x')).toBe(true)
    await expectHello(connection)
  }, 15_000)
})
