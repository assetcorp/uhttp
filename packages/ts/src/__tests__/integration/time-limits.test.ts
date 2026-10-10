import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../index.js'
import { errorCodeOf } from '../helpers/body.js'
import { memoryLogger } from '../helpers/server.js'

function hanging(signals: AbortSignal[]) {
  return (c: { req: { signal: AbortSignal } }) => {
    signals.push(c.req.signal)
    return new Promise<never>(() => undefined)
  }
}

describe('the time limit of a handler', () => {
  beforeEach(async () => {
    await createApp().request('/')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets no time limit by default', async () => {
    const app = createApp().get('/slow', async c => {
      await new Promise(resolve => setTimeout(resolve, 3_600_000))
      return c.text('done')
    })

    const pending = app.request('/slow')
    await vi.advanceTimersByTimeAsync(3_600_000)

    expect(await (await pending).text()).toBe('done')
  })

  it('answers 503 with HANDLER_TIMEOUT, fires the abort signal, and keeps the connection open once the app limit passes', async () => {
    const signals: AbortSignal[] = []
    const app = createApp({ timeoutMs: 1_000 }).get('/hang', hanging(signals))

    const pending = app.request('/hang')
    await vi.advanceTimersByTimeAsync(999)
    expect(signals[0]?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const response = await pending

    expect(response.status).toBe(503)
    expect(await errorCodeOf(response)).toBe('HANDLER_TIMEOUT')
    expect(response.headers.get('connection')).toBeNull()
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[0]?.reason).toEqual(expect.objectContaining({ code: 'HANDLER_TIMEOUT' }))
  })

  it('lets a route set its own limit, or switch the limit of the app off with 0', async () => {
    const app = createApp({ timeoutMs: 1_000 })
      .get('/short', { timeoutMs: 100 }, hanging([]))
      .get('/unlimited', { timeoutMs: 0 }, async c => {
        await new Promise(resolve => setTimeout(resolve, 5_000))
        return c.text('finished')
      })

    const short = app.request('/short')
    const unlimited = app.request('/unlimited')
    await vi.advanceTimersByTimeAsync(100)
    expect((await short).status).toBe(503)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(await (await unlimited).text()).toBe('finished')
  })

  it('sends the headers that middleware set before the limit passed, and the reply of the error handler', async () => {
    const app = createApp({
      timeoutMs: 50,
      onError: (error, c) => c.json({ late: (error as { code: string }).code }, 503),
    })
      .use(async (c, next) => {
        c.header('access-control-allow-origin', 'https://example.com')
        await next()
      })
      .get('/hang', hanging([]))

    const pending = app.request('/hang')
    await vi.advanceTimersByTimeAsync(50)
    const response = await pending

    expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com')
    expect(await response.json()).toEqual({ late: 'HANDLER_TIMEOUT' })
  })

  it('ignores the reply that the handler returns after its limit passed, and logs a warning', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ timeoutMs: 10, logger }).get('/late', async c => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return c.text('too late')
    })

    const pending = app.request('/late')
    await vi.advanceTimersByTimeAsync(20)
    const response = await pending

    expect(response.status).toBe(503)
    expect(entries.map(entry => [entry.level, entry.details.path])).toEqual([['warn', '/late']])
  })

  it('releases the body reader when the limit passes', async () => {
    const outcome: string[] = []
    const app = createApp({ timeoutMs: 100 }).post('/upload', async c => {
      try {
        for await (const _chunk of c.req.body.stream());
      } catch (error) {
        outcome.push((error as { code: string }).code)
      }
      return c.text('read')
    })
    async function* slowBody(): AsyncGenerator<string> {
      yield 'first'
      await new Promise(resolve => setTimeout(resolve, 1_000))
      yield 'second'
    }

    const pending = app.request('/upload', { method: 'POST', body: slowBody() })
    await vi.advanceTimersByTimeAsync(100)

    expect((await pending).status).toBe(503)
    expect(outcome).toEqual(['HANDLER_TIMEOUT'])
  })

  it('refuses a limit that is not a whole number of milliseconds', () => {
    expect(() => createApp({ timeoutMs: -5 })).toThrow(expect.objectContaining({ code: 'INVALID_APP_OPTIONS' }))
    expect(() => createApp().get('/x', { timeoutMs: 0.5 }, c => c.text(''))).toThrow(
      expect.objectContaining({ code: 'INVALID_ROUTE' }),
    )
  })
})
