import { describe, expect, it } from 'vitest'
import { createApp, type Middleware } from '../../index.js'
import { memoryLogger, pause } from '../helpers/server.js'

describe('the request context', () => {
  it('copies the method, the path, the query string, the content type, and the content length for use after an await', async () => {
    const app = createApp().post('/orders', async c => {
      await pause(1)
      const { method, path, query, contentType, contentLength } = c.req
      return c.json({ method, path, query, contentType, contentLength })
    })

    const response = await app.request('/orders?draft=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '0' },
    })

    expect(await response.json()).toEqual({
      method: 'POST',
      path: '/orders',
      query: 'draft=1',
      contentType: 'application/json',
      contentLength: 0,
    })
  })

  it('serves the query string and the content type to a handler that replies without an await', async () => {
    const app = createApp().get('/search', c => c.json({ query: c.req.query, contentType: c.req.contentType ?? null }))

    const response = await app.request('/search?q=shoes', { headers: { 'content-type': 'text/plain' } })

    expect(await response.json()).toEqual({ query: 'q=shoes', contentType: 'text/plain' })
  })

  it('copies the query string for a stream producer that reads it after the handler returned', async () => {
    const app = createApp().get('/feed', c =>
      c.stream(async stream => {
        await pause(1)
        await stream.write(c.req.query)
      }),
    )

    expect(await (await app.request('/feed?since=7')).text()).toBe('since=7')
  })

  it('copies the query for a task on a stream route for HEAD as for GET', async () => {
    const reads: unknown[] = []
    const settled = Promise.withResolvers<void>()
    const app = createApp().get('/feed', c => {
      void (async () => {
        await pause(1)
        try {
          reads.push(c.req.query)
        } catch (error) {
          reads.push((error as { code?: string }).code)
        }
        if (reads.length === 2) settled.resolve()
      })()
      return c.stream(async stream => {
        await stream.write('event')
      })
    })

    const head = await app.request('/feed?topic=a', { method: 'HEAD' })
    const get = await app.request('/feed?topic=b')
    await get.text()
    await settled.promise

    expect([head.status, get.status]).toEqual([200, 200])
    expect(reads.sort()).toEqual(['topic=a', 'topic=b'])
  })

  it('throws REQUEST_RELEASED to a task that first reads the query after the reply went out, as the network does', async () => {
    const outcome = Promise.withResolvers<unknown[]>()
    const app = createApp().get('/audit', c => {
      const contentType = c.req.contentType
      void (async () => {
        await pause(1)
        const results: unknown[] = [c.req.contentType]
        try {
          results.push(c.req.query)
        } catch (error) {
          results.push((error as { code?: string }).code)
        }
        outcome.resolve(results)
      })()
      return c.text(contentType ?? 'none')
    })

    const response = await app.request('/audit?page=2', { headers: { 'content-type': 'text/plain' } })

    expect(await response.text()).toBe('text/plain')
    expect(await outcome.promise).toEqual(['text/plain', 'REQUEST_RELEASED'])
  })

  it('copies the headers that the route declares, and matches each name in any case', async () => {
    const app = createApp().get('/me', { headers: ['Authorization'] }, async c => {
      await pause(1)
      return c.text(c.req.header('AUTHORIZATION') ?? 'none')
    })

    const response = await app.request('/me', { headers: { authorization: 'Bearer abc' } })

    expect(await response.text()).toBe('Bearer abc')
  })

  it('copies the headers that a middleware declares for every route that it wraps', async () => {
    const readsOrigin: Middleware = {
      headers: ['origin'],
      handle: async (c, next) => {
        c.header('x-origin', c.req.header('origin') ?? 'none')
        await next()
      },
    }
    const app = createApp()
      .use(readsOrigin)
      .get('/users', c => c.text(c.req.header('origin') ?? 'none'))

    const response = await app.request('/users', { headers: { origin: 'https://example.com' } })

    expect(response.headers.get('x-origin')).toBe('https://example.com')
    expect(await response.text()).toBe('https://example.com')
  })

  it('sends a 500 and logs a typed error when code asks for a header that nobody declared', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger }).get('/me', c => c.text(c.req.header('authorization') ?? 'none'))

    const response = await app.request('/me', { headers: { authorization: 'Bearer abc' } })

    expect(response.status).toBe(500)
    expect(entries.map(entry => entry.details.err)).toEqual([expect.objectContaining({ code: 'UNDECLARED_HEADER' })])
  })

  it('joins every line of a list header and keeps the first line of any other header', async () => {
    const app = createApp().get('/hops', { headers: ['x-forwarded-for', 'cookie', 'x-tenant'] }, c =>
      c.json(c.req.headers()),
    )

    const response = await app.request('/hops', {
      headers: [
        ['x-forwarded-for', '203.0.113.1'],
        ['X-Forwarded-For', '198.51.100.7'],
        ['cookie', 'a=1'],
        ['cookie', 'b=2'],
        ['x-tenant', 'first'],
        ['x-tenant', 'second'],
      ],
    })

    expect(await response.json()).toEqual({
      'x-forwarded-for': '203.0.113.1, 198.51.100.7',
      cookie: 'a=1; b=2',
      'x-tenant': 'first',
    })
  })

  it('copies every header for a route that declares all of them', async () => {
    const app = createApp().get('/proxy', { headers: 'all' }, c => c.json(c.req.headers()))

    const response = await app.request('/proxy', { headers: { 'X-Custom': 'yes', Accept: 'text/html' } })

    expect(await response.json()).toEqual({ host: 'localhost', 'x-custom': 'yes', accept: 'text/html' })
  })

  it('returns undefined for a declared header that the request leaves out or sends empty', async () => {
    const app = createApp().get('/me', { headers: ['authorization', 'x-empty'] }, c =>
      c.json({ authorization: c.req.header('authorization') ?? null, empty: c.req.header('x-empty') ?? null }),
    )

    const response = await app.request('/me', { headers: { 'x-empty': '' } })

    expect(await response.json()).toEqual({ authorization: null, empty: null })
  })

  it('copies the client address when the route declares it', async () => {
    const app = createApp().get('/where', { clientAddress: true }, async c => {
      await pause(1)
      return c.text(c.req.clientAddress)
    })

    expect(await (await app.request('/where')).text()).toBe('127.0.0.1')
    expect(await (await app.request('/where', { clientAddress: '198.51.100.7' })).text()).toBe('198.51.100.7')
  })

  it('throws a typed error when code asks for a client address that nobody declared', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger }).get('/where', c => c.text(c.req.clientAddress))

    expect((await app.request('/where')).status).toBe(500)
    expect(entries.map(entry => entry.details.err)).toEqual([
      expect.objectContaining({ code: 'UNDECLARED_CLIENT_ADDRESS' }),
    ])
  })

  it('fires the abort signal when the client disconnects before the response ends', async () => {
    const controller = new AbortController()
    const aborted = Promise.withResolvers<boolean>()
    const app = createApp().get('/slow', async c => {
      const signal = c.req.signal
      signal.addEventListener('abort', () => aborted.resolve(true))
      controller.abort()
      return c.text('late')
    })

    await app.request('/slow', { signal: controller.signal })

    expect(await aborted.promise).toBe(true)
  })

  it('returns an aborted signal when code asks for it after the client has gone', async () => {
    const controller = new AbortController()
    controller.abort()
    const app = createApp().get('/gone', c => c.text(String(c.req.signal.aborted)))

    expect(await (await app.request('/gone', { signal: controller.signal })).text()).toBe('true')
  })
})
