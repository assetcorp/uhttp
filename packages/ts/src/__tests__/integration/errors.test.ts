import { describe, expect, it } from 'vitest'
import { type App, createApp, UhttpError } from '../../index.js'
import { memoryLogger } from '../helpers/server.js'

const FAILED_BODY = { error: { code: 'INTERNAL_ERROR', message: 'The request failed.' } }

describe('the error handler', () => {
  it("sends the message 'The request failed.' alone for a 500, whatever the message of the error", async () => {
    const app = createApp().get('/broken', () => {
      throw new UhttpError('UNDECLARED_HEADER', 'secret detail')
    })

    const response = await app.request('/broken')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual(FAILED_BODY)
  })

  it('calls a replacement error handler with the error and the context', async () => {
    const app = createApp({
      onError: (error, c) =>
        c.json({ problem: error instanceof Error ? error.message : 'unknown', path: c.req.path }, 503),
    }).get('/broken', () => {
      throw new Error('the queue is full')
    })

    const response = await app.request('/broken')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ problem: 'the queue is full', path: '/broken' })
  })

  it('falls back to the default reply when the replacement error handler throws', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({
      logger,
      onError: async () => {
        throw new Error('the error handler broke')
      },
    }).get('/missing-user', () => {
      throw new UhttpError('NOT_FOUND', 'No user has that id.')
    })

    const response = await app.request('/missing-user')

    expect(response.status).toBe(404)
    expect(entries.map(entry => entry.details.err)).toEqual([
      expect.objectContaining({ message: 'the error handler broke' }),
    ])
  })

  it('calls a replacement not-found handler after the app middleware', async () => {
    const app = createApp({ notFound: c => c.text(`nothing at ${c.req.path}`, 404) })
      .use(async (c, next) => {
        c.header('x-app', 'ran')
        await next()
      })
      .get('/users', c => c.text('list'))

    const response = await app.request('/missing')

    expect(response.status).toBe(404)
    expect(response.headers.get('x-app')).toBe('ran')
    expect(await response.text()).toBe('nothing at /missing')
  })

  it('throws INVALID_APP_OPTIONS for an option of the wrong type', () => {
    expect(() => Reflect.apply(createApp, undefined, [{ logger: { info: () => undefined } }])).toThrow(UhttpError)
    expect(() => Reflect.apply(createApp, undefined, [{ onError: 'log it' }])).toThrow(UhttpError)
  })
})

describe('the logger', () => {
  it('receives every 500 with the error, the method, and the path', async () => {
    const { entries, logger } = memoryLogger()
    const failure = new Error('the database is down')
    const app = createApp({ logger }).post('/orders', () => {
      throw failure
    })

    await app.request('/orders?draft=1', { method: 'POST' })

    expect(entries).toEqual([
      { level: 'error', details: { err: failure, method: 'POST', path: '/orders' }, message: 'The request failed.' },
    ])
  })

  it('receives nothing for an error below 500', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger }).get('/users/:id', () => {
      throw new UhttpError('NOT_FOUND', 'No user has that id.')
    })

    await app.request('/users/7')
    await app.request('/missing')

    expect(entries).toEqual([])
  })

  it('receives a server error even when a replacement error handler sends another status', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger, onError: (_error, c) => c.text('busy', 503) }).get('/broken', () => {
      throw new Error('crash')
    })

    const response = await app.request('/broken')

    expect(response.status).toBe(503)
    expect(entries.map(entry => entry.details.err)).toEqual([expect.objectContaining({ message: 'crash' })])
  })

  it('falls back to the default reply and logs when the replacement error handler returns no reply', async () => {
    const { entries, logger } = memoryLogger()
    const created: App = Reflect.apply(createApp, undefined, [{ logger, onError: () => 'not a reply' }])
    const app = created.get('/broken', () => {
      throw new UhttpError('NOT_FOUND', 'No user has that id.')
    })

    const response = await app.request('/broken')

    expect(response.status).toBe(404)
    expect(entries.map(entry => entry.details.err)).toEqual([expect.objectContaining({ code: 'MISSING_REPLY' })])
  })

  it('sends the 500 when the logger itself throws', async () => {
    const throwing = () => {
      throw new Error('the log disk is full')
    }
    const app = createApp({ logger: { info: throwing, warn: throwing, error: throwing } }).get('/broken', () => {
      throw new Error('crash')
    })

    expect((await app.request('/broken')).status).toBe(500)
  })
})
