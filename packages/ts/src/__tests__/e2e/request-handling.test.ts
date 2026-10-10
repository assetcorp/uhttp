import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../index.js'
import { openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import { errorBody, expectHello, SMUGGLED_REQUEST } from '../helpers/replies.js'
import { memoryLogger, pause, start } from '../helpers/server.js'

const INTERNAL_ERROR = errorBody('INTERNAL_ERROR', 'The request failed.')
const NOT_FOUND = errorBody('NOT_FOUND', 'The app has no route for this path.')

describe('the copy from uWebSockets.js', () => {
  it('copies the method, the path, the query, the parameters, the content type, and the length before any await', async () => {
    const app = createApp().post('/users/:id/files/:name', async c => {
      await pause(5)
      const { method, path, query, contentType, contentLength } = c.req
      return c.json({ method, path, query, contentType, contentLength, params: c.req.params() })
    })
    const server = await start(app)

    const { response } = await send(
      server.port,
      requestWithBody('POST', '/users/42/files/a%2Fb?draft=1', ['Content-Type: text/plain'], 'hello'),
    )

    expect(JSON.parse(response.body.toString())).toEqual({
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

    const { response } = await send(
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
    const server = await start(createApp().get('/proxy', { headers: 'all' }, c => c.json(c.req.headers())))

    const { response } = await send(
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

    const { response } = await send(server.port, requestHead('GET', '/where'))

    expect(response.body.toString()).toBe('127.0.0.1')
  })

  it('sends a 500 and logs when the copy inside the synchronous handler throws, and keeps the connection open', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger })
      .get('/where', { clientAddress: true }, c => c.text(c.req.clientAddress))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)
    const spy = vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
      throw new Error('the copy failed')
    })

    try {
      const response = await connection.exchange(requestHead('GET', '/where'))
      expect([response.status, response.body.toString()]).toEqual([500, INTERNAL_ERROR])
    } finally {
      spy.mockRestore()
    }
    expect(entries.map(entry => entry.details)).toEqual([
      { err: expect.objectContaining({ message: 'the copy failed' }), method: 'GET', path: '/where' },
    ])
    await expectHello(connection)
  })
})

describe('client disconnects', () => {
  it('fires the abort signal, skips the write, and serves the next client', async () => {
    const { entries, logger } = memoryLogger()
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const app = createApp({ logger })
      .get('/slow', async c => {
        c.req.signal.addEventListener('abort', () => aborted.resolve())
        started.resolve()
        await aborted.promise
        finished.resolve()
        return c.text('late', 200, { 'x-late': 'yes' })
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const abandoned = await openConnection(server.port)

    void abandoned.write(requestHead('GET', '/slow'))
    await started.promise
    abandoned.destroy()
    await finished.promise
    await pause(10)

    await expectHello(await openConnection(server.port))
    expect(entries).toEqual([])
  })
})

describe('the fallback replies over the network', () => {
  it('sends a 404, a 405 with Allow, and the methods of the path for OPTIONS on one connection', async () => {
    const app = createApp()
      .get('/users', c => c.text('list'))
      .delete('/users/:id', c => c.text('deleted'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const missing = await connection.exchange(requestHead('GET', '/missing'))
    const wrong = await connection.exchange(requestHead('PUT', '/users'))
    const options = await connection.exchange(requestHead('OPTIONS', '/users/7'))

    expect([missing.status, missing.body.toString()]).toEqual([404, NOT_FOUND])
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toEqual(['GET, HEAD, OPTIONS'])
    expect(wrong.body.toString()).toBe(
      errorBody('METHOD_NOT_ALLOWED', 'This path has routes for GET, HEAD, OPTIONS alone.'),
    )
    expect([options.status, options.framing]).toEqual([204, 'none'])
    expect(options.headers.get('allow')).toEqual(['DELETE, OPTIONS'])
    expect(await connection.waitForClose(200)).toBe('open')
  })

  it('takes the method with its case, so that a lowercase get gets a 405 and never reaches the GET handler', async () => {
    const handled: string[] = []
    const server = await start(
      createApp().get('/users', c => {
        handled.push('users')
        return c.text('list')
      }),
    )

    const { response } = await send(server.port, requestHead('get', '/users'))

    expect(response.status).toBe(405)
    expect(handled).toEqual([])
  })

  it('wraps the 404 with the app middleware', async () => {
    const app = createApp()
      .use(async (c, next) => {
        c.header('x-request-seen', 'yes')
        await next()
      })
      .get('/users', c => c.text('list'))
    const server = await start(app)

    const { response } = await send(server.port, requestHead('GET', '/missing'))

    expect(response.headers.get('x-request-seen')).toEqual(['yes'])
    expect(response.body.toString()).toBe(NOT_FOUND)
  })

  it('sends a 400 when a parameter fails to decode', async () => {
    const server = await start(createApp().get('/users/:id', c => c.text('never')))

    const { response } = await send(server.port, requestHead('GET', '/users/%E0%A4%A'))

    expect(response.status).toBe(400)
    expect(response.body.toString()).toBe(
      errorBody('INVALID_PATH_PARAMETER', 'A path parameter contains a percent sequence that fails to decode.'),
    )
  })
})

describe('HEAD over the network', () => {
  it('sends the headers and the length of the GET reply, and no body before the next response', async () => {
    const app = createApp()
      .get('/users', c => c.json({ users: ['Ama', 'Kofi'] }))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('HEAD', '/users') + requestHead('GET', '/hello'))
    const head = await connection.response({ method: 'HEAD' })
    const next = await connection.response()

    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toEqual(['application/json'])
    expect(head.headers.get('content-length')).toEqual([String('{"users":["Ama","Kofi"]}'.length)])
    expect([next.status, next.body.toString()]).toEqual([200, 'Hello'])
  })

  it('calls the middleware of the GET route for HEAD, so that HEAD reaches no handler that the middleware denies', async () => {
    const handled: string[] = []
    const app = createApp().get(
      '/account',
      async (c, next) => {
        if (c.req.method === 'GET' || c.req.method === 'HEAD') return c.text('denied', 401)
        await next()
      },
      c => {
        handled.push(c.req.method)
        return c.text('secret')
      },
    )
    const server = await start(app)
    const connection = await openConnection(server.port)

    const head = await connection.exchange(requestHead('HEAD', '/account'), { method: 'HEAD' })
    const get = await connection.exchange(requestHead('GET', '/account'))

    expect([head.status, head.headers.get('content-length')]).toEqual([401, ['6']])
    expect([get.status, get.body.toString()]).toEqual([401, 'denied'])
    expect(handled).toEqual([])
  })
})

describe('the header writer over the network', () => {
  it.each([
    ['a header value', '/value'],
    ['a header name', '/name'],
    ['a redirect location', '/redirect'],
  ])('sends a 500 in place of %s with CRLF, so that no header is injected', async (_name, path) => {
    const app = createApp()
      .get('/value', c => c.text('list', 200, { 'x-bad': 'a\r\nset-cookie: admin=1' }))
      .get('/name', c => {
        c.header('x-bad\r\nset-cookie', 'admin=1')
        return c.text('list')
      })
      .get('/redirect', c => c.redirect('/login\r\nset-cookie: admin=1'))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', path))

    expect([response.status, response.body.toString()]).toEqual([500, INTERNAL_ERROR])
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(response.headers.has('location')).toBe(false)
    await expectHello(connection)
  })

  it('keeps the framing of the reply when a handler sets Content-Length, Transfer-Encoding, or Connection', async () => {
    const app = createApp()
      .get('/framed', c => {
        c.header('content-length', '999')
        c.header('transfer-encoding', 'chunked')
        c.header('connection', 'close')
        return c.text('framed')
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', '/framed'))

    expect(response.headers.get('content-length')).toEqual(['6'])
    expect(response.headers.has('transfer-encoding')).toBe(false)
    expect(response.headers.has('connection')).toBe(false)
    expect(response.body.toString()).toBe('framed')
    await expectHello(connection)
  })

  it('sends none of the headers of a reply that a later error reply replaces', async () => {
    const app = createApp()
      .use(async (_c, next) => {
        await next()
        throw new Error('the audit log is down')
      })
      .get('/account', c => c.redirect('/login', 302, { 'set-cookie': 'session=abc' }))
    const server = await start(app)

    const { response } = await send(server.port, requestHead('GET', '/account'))

    expect([response.status, response.body.toString()]).toEqual([500, INTERNAL_ERROR])
    expect(response.headers.has('location')).toBe(false)
    expect(response.headers.has('set-cookie')).toBe(false)
  })
})

describe('bodies sent to routes that read none', () => {
  it.each([
    ['a GET route', 'GET', '/hello'],
    ['a path with no route', 'POST', '/missing'],
  ])('skips a body sent to %s, and runs no request hidden in that body', async (_name, method, path) => {
    const handled: string[] = []
    const app = createApp()
      .get('/hello', c => c.text('Hello'))
      .get('/admin', c => {
        handled.push('admin')
        return c.text('admin')
      })
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(
      Buffer.concat([requestWithBody(method, path, [], SMUGGLED_REQUEST), Buffer.from(requestHead('GET', '/hello'))]),
    )
    const first = await connection.response()
    const next = await connection.response()

    expect(first.status).toBe(path === '/hello' ? 200 : 404)
    expect([next.status, next.body.toString()]).toEqual([200, 'Hello'])
    expect(handled).toEqual([])
  })
})
