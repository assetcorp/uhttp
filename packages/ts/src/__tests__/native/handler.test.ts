import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../index.js'
import { rawRequest, requestHead } from '../helpers/raw-http.js'
import { memoryLogger, pause, start, urlOf } from '../helpers/server.js'

describe('the copy from uWebSockets.js', () => {
  it('copies the method, the path, the query, the parameters, the content type, and the length before any await', async () => {
    const app = createApp().post('/users/:id/files/:name', async c => {
      await pause(5)
      const { method, path, query, contentType, contentLength } = c.req
      return c.json({ method, path, query, contentType, contentLength, params: c.req.params() })
    })
    const server = await start(app)

    const response = await fetch(urlOf(server, '/users/42/files/a%2Fb?draft=1'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })

    expect(await response.json()).toEqual({
      method: 'POST',
      path: '/users/42/files/a%2Fb',
      query: 'draft=1',
      contentType: 'text/plain',
      contentLength: 5,
      params: { id: '42', name: 'a/b' },
    })
  })

  it('collects every line of a list header and the first line of any other header', async () => {
    const app = createApp().get('/hops', { headers: ['x-forwarded-for', 'cookie', 'x-tenant'] }, async c => {
      await pause(1)
      return c.json(c.req.headers())
    })
    const server = await start(app)

    const response = await rawRequest(
      server.port,
      requestHead('GET', '/hops', [
        'X-Forwarded-For: 203.0.113.1',
        'x-forwarded-for: 198.51.100.7',
        'Cookie: a=1',
        'cookie: b=2',
        'x-tenant: first',
        'x-tenant: second',
      ]),
    )

    expect(JSON.parse(response.body.toString())).toEqual({
      'x-forwarded-for': '203.0.113.1, 198.51.100.7',
      cookie: 'a=1; b=2',
      'x-tenant': 'first',
    })
  })

  it('copies every header for a route that declares all of them', async () => {
    const app = createApp().get('/proxy', { headers: 'all' }, c => c.json(c.req.headers()))
    const server = await start(app)

    const response = await rawRequest(
      server.port,
      requestHead('GET', '/proxy', ['X-Custom: yes', 'Accept: a', 'accept: b']),
    )

    expect(JSON.parse(response.body.toString())).toEqual({ host: 'localhost', 'x-custom': 'yes', accept: 'a, b' })
  })

  it('copies the client address when a middleware declares it', async () => {
    const app = createApp()
      .use({ clientAddress: true, handle: (_c, next) => next() })
      .get('/where', async c => {
        await pause(1)
        return c.text(c.req.clientAddress)
      })
    const server = await start(app)

    expect(await (await fetch(urlOf(server, '/where'))).text()).toBe('127.0.0.1')
  })

  it('sends a 500 and logs when the copy inside the synchronous handler throws', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger }).get('/where', { clientAddress: true }, c => c.text(c.req.clientAddress))
    const server = await start(app)
    const spy = vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
      throw new Error('the copy failed')
    })

    try {
      const response = await fetch(urlOf(server, '/where'))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'The request failed.' } })
    } finally {
      spy.mockRestore()
    }
    expect(entries.map(entry => entry.details)).toEqual([
      { err: expect.objectContaining({ message: 'the copy failed' }), method: 'GET', path: '/where' },
    ])
  })
})

describe('client disconnects', () => {
  it('fires the abort signal and skips the write once the client goes', async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const app = createApp()
      .get('/slow', async c => {
        c.req.signal.addEventListener('abort', () => aborted.resolve())
        started.resolve()
        await aborted.promise
        finished.resolve()
        return c.text('late', 200, { 'x-late': 'yes' })
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const controller = new AbortController()
    const abandoned = fetch(urlOf(server, '/slow'), { signal: controller.signal })
    await started.promise
    controller.abort()
    await expect(abandoned).rejects.toThrow()
    await finished.promise
    await pause(10)

    expect(await (await fetch(urlOf(server, '/hello'))).text()).toBe('Hello')
  })
})

describe('the fallback replies over the network', () => {
  it('sends a 404, a 405 with Allow, and the methods of the path for OPTIONS', async () => {
    const app = createApp()
      .get('/users', c => c.text('list'))
      .delete('/users/:id', c => c.text('deleted'))
    const server = await start(app)

    const missing = await fetch(urlOf(server, '/missing'))
    const wrong = await fetch(urlOf(server, '/users'), { method: 'PUT' })
    const options = await fetch(urlOf(server, '/users/7'), { method: 'OPTIONS' })

    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'The app has no route for this path.' },
    })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    expect(options.status).toBe(204)
    expect(options.headers.get('allow')).toBe('DELETE, OPTIONS')
  })

  it('takes the method with its case, so a lowercase get gets a 405', async () => {
    const server = await start(createApp().get('/users', c => c.text('list')))

    const response = await rawRequest(server.port, requestHead('get', '/users'))

    expect(response.status).toBe(405)
  })

  it('wraps the 404 with the app middleware', async () => {
    const app = createApp()
      .use(async (c, next) => {
        c.header('x-request-seen', 'yes')
        await next()
      })
      .get('/users', c => c.text('list'))
    const server = await start(app)

    const response = await fetch(urlOf(server, '/missing'))

    expect(response.headers.get('x-request-seen')).toBe('yes')
  })

  it('sends a 400 when a parameter fails to decode', async () => {
    const server = await start(createApp().get('/users/:id', c => c.text('never')))

    expect((await rawRequest(server.port, requestHead('GET', '/users/%E0%A4%A'))).status).toBe(400)
  })
})

describe('HEAD over the network', () => {
  it('sends the headers and the length of the GET reply with no body', async () => {
    const server = await start(createApp().get('/users', c => c.json({ users: ['Ama', 'Kofi'] })))

    const response = await rawRequest(server.port, requestHead('HEAD', '/users'), { bodyless: true })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toEqual(['application/json'])
    expect(response.headers.get('content-length')).toEqual([String('{"users":["Ama","Kofi"]}'.length)])
    expect(response.body.length).toBe(0)
  })
})

describe('the header writer over the network', () => {
  it('sends a 500 in place of a header value with CRLF, so that no header is injected', async () => {
    const server = await start(
      createApp().get('/users', c => c.text('list', 200, { 'x-bad': 'a\r\nset-cookie: admin=1' })),
    )

    const response = await rawRequest(server.port, requestHead('GET', '/users'))

    expect(response.status).toBe(500)
    expect(response.headers.has('set-cookie')).toBe(false)
  })

  it('sends none of the headers of a reply that a later error reply replaces', async () => {
    const app = createApp()
      .use(async (_c, next) => {
        await next()
        throw new Error('the audit log is down')
      })
      .get('/account', c => c.redirect('/login', 302, { 'set-cookie': 'session=abc' }))
    const server = await start(app)

    const response = await rawRequest(server.port, requestHead('GET', '/account'))

    expect(response.status).toBe(500)
    expect(response.headers.has('location')).toBe(false)
    expect(response.headers.has('set-cookie')).toBe(false)
  })
})
