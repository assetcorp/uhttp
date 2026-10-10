import { describe, expect, it } from 'vitest'
import { createApp, type ResponseStream } from '../../index.js'
import { memoryLogger, pause } from '../helpers/server.js'

describe('streamed replies through app.request()', () => {
  it('sends the chunks of a stream of unknown length', async () => {
    const app = createApp().get('/count', c =>
      c.stream(
        async stream => {
          for (const word of ['one ', 'two ', 'three']) await stream.write(word)
        },
        { contentType: 'text/plain' },
      ),
    )

    const response = await app.request('/count')

    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.text()).toBe('one two three')
  })

  it('sends a content-length for a stream of known length', async () => {
    const app = createApp().get('/bytes', c =>
      c.stream(
        async stream => {
          await stream.write(new Uint8Array([1, 2]))
          await stream.write(new Uint8Array([3]))
        },
        { length: 3 },
      ),
    )

    const response = await app.request('/bytes')

    expect(response.headers.get('content-length')).toBe('3')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('starts the producer only after the chain returns, so middleware can add headers', async () => {
    const trace: string[] = []
    const app = createApp()
      .use(async (c, next) => {
        await next()
        c.header('x-after', 'yes')
        trace.push('middleware returned')
      })
      .get('/stream', c =>
        c.stream(async stream => {
          trace.push('producer started')
          await stream.write('data')
        }),
      )

    const response = await app.request('/stream')
    await response.text()

    expect(response.headers.get('x-after')).toBe('yes')
    expect(trace).toEqual(['middleware returned', 'producer started'])
  })

  it('leaves the producer uncalled for a HEAD request', async () => {
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

    const response = await app.request('/download', { method: 'HEAD' })

    expect(response.headers.get('content-length')).toBe('3')
    expect(await response.text()).toBe('')
    expect(started).toBe(false)
  })

  it('errors the body and logs when the producer throws part of the way through', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger }).get('/fails', c =>
      c.stream(async stream => {
        await stream.write('partial ')
        throw new Error('the upstream closed')
      }),
    )

    const response = await app.request('/fails')

    await expect(response.text()).rejects.toThrow('the upstream closed')
    expect(entries.map(entry => entry.details.err)).toEqual([
      expect.objectContaining({ message: 'the upstream closed' }),
    ])
  })

  it('errors the body when the producer writes fewer bytes than it declared', async () => {
    const app = createApp().get('/short', c =>
      c.stream(stream => stream.write('ab').then(() => undefined), { length: 5 }),
    )

    await expect((await app.request('/short')).text()).rejects.toThrow(/fewer|declared/)
  })

  it('rejects a write that takes the body past the declared length', async () => {
    const app = createApp().get('/long', c =>
      c.stream(
        async stream => {
          await stream.write('abcdef')
        },
        { length: 3 },
      ),
    )

    await expect((await app.request('/long')).text()).rejects.toThrow(/more bytes/)
  })

  it('keeps each write pending while the test reads slowly, and resolves writes to false once the test cancels', async () => {
    const results: boolean[] = []
    const finished = Promise.withResolvers<void>()
    const app = createApp().get('/slow', c =>
      c.stream(async stream => {
        for (let index = 0; index < 5; index++) results.push(await stream.write(`chunk ${index}`))
        finished.resolve()
      }),
    )

    const response = await app.request('/slow')
    const reader = response.body?.getReader()
    await reader?.read()
    await pause(10)
    const writtenBeforeCancel = results.length
    await reader?.cancel()
    await finished.promise

    expect(writtenBeforeCancel).toBeLessThan(5)
    expect(results.at(-1)).toBe(false)
  })

  it('settles every pending write, whether the test reads the body or cancels it', async () => {
    const settled: Promise<boolean[]>[] = []
    const writeThree = (stream: ResponseStream): Promise<boolean[]> => {
      const all = Promise.all([stream.write('a'), stream.write('b'), stream.write('c')])
      settled.push(all)
      return all
    }
    const app = createApp()
      .get('/read', c => c.stream(stream => writeThree(stream).then(() => undefined)))
      .get('/cancel', c =>
        c.stream(stream => {
          void writeThree(stream)
          return new Promise(() => undefined)
        }),
      )

    expect(await (await app.request('/read')).text()).toBe('abc')
    const cancelled = await app.request('/cancel')
    await cancelled.body?.cancel()

    expect(await settled[0]).toEqual([true, true, true])
    expect(await settled[1]).toEqual([false, false, false])
  })

  it('throws INVALID_STREAM for a length that is not a whole number of zero or more', async () => {
    const app = createApp().get('/bad', c => c.stream(() => undefined, { length: -1 }))

    expect((await app.request('/bad')).status).toBe(500)
  })
})
