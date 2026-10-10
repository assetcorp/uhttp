import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createApp, type Server } from '../../index.js'
import { rawRequest, requestHead } from '../helpers/raw-http.js'
import { memoryLogger, pause, start, urlOf } from '../helpers/server.js'

const CHUNK_BYTES = 1024 * 1024
const CHUNK_COUNT = 32
const TOTAL_BYTES = CHUNK_BYTES * CHUNK_COUNT

function largeStreamApp(length: number | undefined, progress: { written: number; done: boolean }) {
  return createApp().get('/large', c =>
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
}

async function readSlowly(server: Server, progress: { written: number }): Promise<{ held: number; received: number }> {
  const socket = connect(server.port, '127.0.0.1')
  let received = 0
  const ended = Promise.withResolvers<void>()
  socket.on('data', chunk => {
    received += chunk.length
  })
  socket.on('close', () => ended.resolve())
  socket.pause()
  socket.write(requestHead('GET', '/large', ['Connection: close']))
  await pause(300)
  const held = progress.written
  socket.resume()
  await ended.promise
  return { held, received }
}

describe('streamed replies over the network', () => {
  it('waits on onWritable while the client is slow, for a body of unknown length', async () => {
    const progress = { written: 0, done: false }
    const server = await start(largeStreamApp(undefined, progress))

    const { held, received } = await readSlowly(server, progress)

    expect(held).toBeLessThan(CHUNK_COUNT)
    expect(progress.done).toBe(true)
    expect(received).toBeGreaterThan(TOTAL_BYTES)
  })

  it('waits on onWritable while the client is slow, for a body of known length', async () => {
    const progress = { written: 0, done: false }
    const server = await start(largeStreamApp(TOTAL_BYTES, progress))

    const { held, received } = await readSlowly(server, progress)

    expect(held).toBeLessThan(CHUNK_COUNT)
    expect(progress.done).toBe(true)
    expect(received).toBeGreaterThan(TOTAL_BYTES)
  })

  it('delivers the whole body of known length to fetch', async () => {
    const progress = { written: 0, done: false }
    const server = await start(largeStreamApp(TOTAL_BYTES, progress))

    const response = await fetch(urlOf(server, '/large'))
    const body = new Uint8Array(await response.arrayBuffer())

    expect(response.headers.get('content-length')).toBe(String(TOTAL_BYTES))
    expect(body.length).toBe(TOTAL_BYTES)
  })

  it('sends a chunked body with the headers that middleware added after the chain returned', async () => {
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
    const server = await start(app)

    const response = await fetch(urlOf(server, '/words'))

    expect(response.headers.get('x-after')).toBe('yes')
    expect(response.headers.get('transfer-encoding')).toBe('chunked')
    expect(await response.text()).toBe('one two')
  })

  it('closes the connection when the producer fails part of the way through', async () => {
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

    for (const path of ['/chunked', '/sized']) {
      const response = await fetch(urlOf(server, path))
      await expect(response.arrayBuffer(), path).rejects.toThrow()
    }
    expect(entries.map(entry => entry.details.err)).toEqual([
      expect.objectContaining({ message: 'the upstream closed' }),
      expect.objectContaining({ code: 'INVALID_STREAM' }),
    ])
  })

  it('sends the headers and the declared length for HEAD, and never calls the producer', async () => {
    let started = false
    const app = createApp().get('/download', c =>
      c.stream(
        async stream => {
          started = true
          await stream.write('abc')
        },
        { length: 3 },
      ),
    )
    const server = await start(app)

    const response = await rawRequest(server.port, requestHead('HEAD', '/download'), { bodyless: true })

    expect(response.headers.get('content-length')).toEqual(['3'])
    expect(started).toBe(false)
  })

  it('sends no content-length for HEAD to a stream of unknown length, as app.request() does', async () => {
    const app = createApp().get('/feed', c => c.stream(stream => stream.write('entry').then(() => undefined)))
    const server = await start(app)

    const native = await rawRequest(server.port, requestHead('HEAD', '/feed'), { bodyless: true })
    const tested = await app.request('/feed', { method: 'HEAD' })

    expect(native.headers.has('content-length')).toBe(false)
    expect(tested.headers.has('content-length')).toBe(false)
  })

  it('sends a 500 in place of a stream content type with CRLF, so that no header is injected', async () => {
    const app = createApp().get('/report', c =>
      c.stream(stream => stream.write('rows').then(() => undefined), { contentType: 'text/csv\r\nx-injected: yes' }),
    )
    const server = await start(app)

    const native = await rawRequest(server.port, requestHead('GET', '/report'))
    const tested = await app.request('/report')

    expect(native.status).toBe(500)
    expect(native.headers.has('x-injected')).toBe(false)
    expect(tested.status).toBe(500)
  })

  it('resolves writes to false once the client has gone', async () => {
    const results: boolean[] = []
    const finished = Promise.withResolvers<void>()
    const app = createApp().get('/endless', c =>
      c.stream(async stream => {
        while (results.at(-1) !== false) {
          results.push(await stream.write(new Uint8Array(64 * 1024)))
          await pause(1)
        }
        finished.resolve()
      }),
    )
    const server = await start(app)

    const controller = new AbortController()
    const response = await fetch(urlOf(server, '/endless'), { signal: controller.signal })
    await response.body?.getReader().read()
    controller.abort()
    await finished.promise

    expect(results.at(-1)).toBe(false)
  })
})

describe('server-sent events over the network', () => {
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

    const controller = new AbortController()
    const response = await fetch(urlOf(server, '/events'), { signal: controller.signal })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes(':\n\n')) {
      const { value } = (await reader?.read()) ?? {}
      text += decoder.decode(value)
    }
    controller.abort()

    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(text.startsWith('event: greeting\ndata: hello\n\n')).toBe(true)
    expect(await closed.promise).toBe(true)
  })

  it('stops the heartbeat when the producer returns while the client still reads slowly', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    const returned = Promise.withResolvers<void>()
    const app = createApp().get('/events', c =>
      c.sse(
        events => {
          void events.send({ data: 'x'.repeat(CHUNK_BYTES * 16) })
          returned.resolve()
        },
        { heartbeatMs: 10 },
      ),
    )
    const server = await start(app)
    const socket = connect(server.port, '127.0.0.1')
    socket.pause()
    socket.write(requestHead('GET', '/events'))

    try {
      await returned.promise
      await pause(150)
      expect(unhandled).toEqual([])
    } finally {
      socket.destroy()
      process.off('unhandledRejection', record)
    }
  })
})
