import { describe, expect, it, vi } from 'vitest'
import { createApp, type ServerSentEvent } from '../../index.js'
import { memoryLogger, pause } from '../helpers/server.js'

async function eventsOf(event: ServerSentEvent): Promise<string> {
  const app = createApp().get('/events', c =>
    c.sse(async events => {
      await events.send(event)
    }),
  )
  return (await app.request('/events')).text()
}

describe('the server-sent events helper', () => {
  it('sends the event stream headers', async () => {
    const app = createApp().get('/events', c => c.sse(() => undefined))

    const response = await app.request('/events')

    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('content-length')).toBeNull()
  })

  it('sends the event name, the ID, the retry time, and the data in that order', async () => {
    expect(await eventsOf({ event: 'price', id: '7', retry: 3000, data: '42' })).toBe(
      'event: price\nid: 7\nretry: 3000\ndata: 42\n\n',
    )
  })

  it('splits the data on CR, LF, and CRLF into one data field per line', async () => {
    expect(await eventsOf({ data: 'one\rtwo\nthree\r\nfour' })).toBe(
      'data: one\ndata: two\ndata: three\ndata: four\n\n',
    )
  })

  it('throws INVALID_EVENT for CR or LF in an event name or an ID, and for NUL in an ID', async () => {
    const bad: ServerSentEvent[] = [
      { event: 'a\nb', data: 'x' },
      { event: 'a\rb', data: 'x' },
      { id: '1\n2', data: 'x' },
      { id: '1\r2', data: 'x' },
      { id: '1\u00002', data: 'x' },
    ]
    for (const event of bad) {
      const { entries, logger } = memoryLogger()
      const app = createApp({ logger }).get('/events', c => c.sse(events => events.send(event).then(() => undefined)))
      await expect((await app.request('/events')).text(), JSON.stringify(event)).rejects.toThrow()
      expect(entries.map(entry => entry.details.err)).toEqual([expect.objectContaining({ code: 'INVALID_EVENT' })])
    }
  })

  it('throws INVALID_EVENT for a retry time that is not a whole number of zero or more', async () => {
    for (const retry of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const app = createApp().get('/events', c => c.sse(events => events.send({ retry }).then(() => undefined)))
      await expect((await app.request('/events')).text(), String(retry)).rejects.toThrow(/retry/)
    }
    expect(await eventsOf({ retry: 0 })).toBe('retry: 0\n\n')
  })

  it('sends a heartbeat comment at the interval that you choose', async () => {
    const app = createApp().get('/events', c =>
      c.sse(
        async events => {
          await pause(70)
          await events.send({ data: 'done' })
        },
        { heartbeatMs: 20 },
      ),
    )

    const body = await (await app.request('/events')).text()

    expect(body.startsWith(':\n\n')).toBe(true)
    expect(body.endsWith('data: done\n\n')).toBe(true)
  })

  it('sends no heartbeat when you switch it off', async () => {
    const app = createApp().get('/events', c =>
      c.sse(
        async events => {
          await pause(40)
          await events.send({ data: 'done' })
        },
        { heartbeatMs: 0 },
      ),
    )

    expect(await (await app.request('/events')).text()).toBe('data: done\n\n')
  })

  it('stops the heartbeat when the stream ends and when the client goes', async () => {
    const closes: string[] = []
    const app = createApp()
      .get('/ends', c =>
        c.sse(
          events => {
            events.onClose(() => closes.push('ended'))
          },
          { heartbeatMs: 5 },
        ),
      )
      .get('/abandoned', c =>
        c.sse(
          events => {
            events.onClose(() => closes.push(`abandoned closed=${events.closed}`))
            return new Promise(() => undefined)
          },
          { heartbeatMs: 5 },
        ),
      )

    await (await app.request('/ends')).text()
    const response = await app.request('/abandoned')
    const reader = response.body?.getReader()
    await reader?.read()
    await reader?.cancel()

    expect(closes).toEqual(['ended', 'abandoned closed=true'])
  })

  it('sends the first heartbeat after 30 seconds by default', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const release = Promise.withResolvers<void>()
      const app = createApp().get('/events', c =>
        c.sse(async events => {
          await release.promise
          await events.send({ data: 'done' })
        }),
      )
      const response = await app.request('/events')
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      const first = reader?.read()
      let received = false
      void first?.then(() => {
        received = true
      })

      vi.advanceTimersByTime(29_999)
      await pause(5)
      const beforeThirtySeconds = received
      vi.advanceTimersByTime(1)
      const chunk = await first
      release.resolve()

      expect(beforeThirtySeconds).toBe(false)
      expect(decoder.decode(chunk?.value)).toBe(':\n\n')
      await reader?.cancel()
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws INVALID_STREAM for a heartbeat interval that is not a whole number of zero or more', async () => {
    for (const heartbeatMs of [-5, 2.5]) {
      const app = createApp().get('/events', c => c.sse(() => undefined, { heartbeatMs }))
      expect((await app.request('/events')).status).toBe(500)
    }
  })
})
