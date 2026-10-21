import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../index.js'
import { KIB, MIB } from '../helpers/apps.js'
import { openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import { errorBody, expectClosedAfterReply, expectHello } from '../helpers/replies.js'
import { memoryLogger, pause, start } from '../helpers/server.js'

const INTERNAL_ERROR = errorBody('INTERNAL_ERROR', 'The request failed.')

describe('the copy from uWebSockets.js', () => {
  it('copies the method, the path, the query, the parameters, the content type, and the length before any await', async () => {
    const app = createApp()
      .post('/users/:id/files/:name', async c => {
        await pause(5)
        const { method, path, query, contentType, contentLength } = c.req
        return c.json({ method, path, query, contentType, contentLength, params: c.req.params() })
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(
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
    await expectHello(connection)
  })

  it('collects every line of a list header and the first line of any other header', async () => {
    const app = createApp()
      .get('/hops', { headers: ['x-forwarded-for', 'cookie', 'x-tenant'] }, async c => {
        await pause(1)
        return c.json(c.req.headers())
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(
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
    await expectHello(connection)
  })

  it('copies every header for a route that declares all of them', async () => {
    const server = await start(
      createApp()
        .get('/proxy', { headers: 'all' }, c => c.json(c.req.headers()))
        .get('/hello', c => c.text('Hello')),
    )

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/proxy', ['X-Custom: yes', 'Accept: a', 'accept: b']),
    )

    expect(JSON.parse(response.body.toString())).toEqual({ host: 'localhost', 'x-custom': 'yes', accept: 'a, b' })
    await expectHello(connection)
  })

  it('copies the client address when a middleware declares it', async () => {
    const app = createApp()
      .use({ clientAddress: true, handle: (_c, next) => next() })
      .get('/where', async c => {
        await pause(1)
        return c.text(c.req.clientAddress)
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(server.port, requestHead('GET', '/where'))

    expect(response.body.toString()).toBe('127.0.0.1')
    await expectHello(connection)
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

  it('sends a 500 without a body to a HEAD request whose copy throws, and keeps the connection open', async () => {
    const app = createApp({ logger: memoryLogger().logger })
      .get('/where', { clientAddress: true }, c => c.text(c.req.clientAddress))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)
    const spy = vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
      throw new Error('the copy failed')
    })

    try {
      void connection.write(requestHead('HEAD', '/where'))
      const response = await connection.response({ method: 'HEAD' })
      expect([response.status, response.headers.get('content-length'), response.body.byteLength]).toEqual([
        500,
        [String(Buffer.byteLength(INTERNAL_ERROR))],
        0,
      ])
    } finally {
      spy.mockRestore()
    }
    await expectHello(connection)
  })

  it('closes the connection after the 500 when the copy throws while more of the body is on its way than the package discards', async () => {
    const app = createApp({ logger: memoryLogger().logger }).post(
      '/where',
      { clientAddress: true, maxBodyBytes: 2 * MIB },
      c => c.text(c.req.clientAddress),
    )
    const server = await start(app)
    const connection = await openConnection(server.port)
    const head = requestHead('POST', '/where', ['Content-Type: text/plain', `Content-Length: ${MIB}`])
    const firstPart = Buffer.alloc(KIB, 97)
    const spy = vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
      throw new Error('the copy failed')
    })

    try {
      void connection.write(head)
      void connection.write(firstPart)
      const response = await connection.response()
      expect([response.status, response.body.toString()]).toEqual([500, INTERNAL_ERROR])
      await expectClosedAfterReply(connection, response)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('the query string and the content type, which the package reads when code first asks', () => {
  it('serves both to a handler that replies without an await, and keeps the connection open', async () => {
    const app = createApp()
      .post('/echo', { body: false }, c => c.json({ query: c.req.query, contentType: c.req.contentType ?? null }))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(
      server.port,
      requestHead('POST', '/echo?page=2', ['Content-Type: text/csv', 'Content-Length: 0']),
    )

    expect(JSON.parse(response.body.toString())).toEqual({ query: 'page=2', contentType: 'text/csv' })
    await expectHello(connection)
  })

  it('copies the request for a handler that first reads it after an await, on a route without middleware', async () => {
    const app = createApp()
      .get('/later', async c => {
        await pause(5)
        const { method, path, route, query, contentType, contentLength } = c.req
        return c.json({ method, path, route, query, contentType, contentLength: contentLength ?? null })
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/later?page=3', ['Content-Type: text/csv']),
    )

    expect(JSON.parse(response.body.toString())).toEqual({
      method: 'GET',
      path: '/later',
      route: '/later',
      query: 'page=3',
      contentType: 'text/csv',
      contentLength: null,
    })
    await expectHello(connection)
  })

  it('gives a task that first reads the request after the reply its method, path, and route, and REQUEST_RELEASED for the rest', async () => {
    const outcome = Promise.withResolvers<unknown[]>()
    const codeOf = (read: () => unknown): unknown => {
      try {
        return read()
      } catch (error) {
        return (error as { code?: string }).code
      }
    }
    const app = createApp()
      .get('/audit', c => {
        void (async () => {
          await pause(5)
          const { method, path, route } = c.req
          outcome.resolve([method, path, route, codeOf(() => c.req.query), codeOf(() => c.req.contentType)])
        })()
        return c.text('sent')
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/audit?page=2', ['Content-Type: text/plain']),
    )

    expect(response.body.toString()).toBe('sent')
    expect(await outcome.promise).toEqual(['GET', '/audit', '/audit', 'REQUEST_RELEASED', 'REQUEST_RELEASED'])
    await expectHello(connection)
  })

  it('reads the length of a body that a client sends to a GET route without middleware, and keeps the connection open', async () => {
    const app = createApp()
      .get('/sized', c => c.json({ contentLength: c.req.contentLength ?? null, query: c.req.query }))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(server.port, requestWithBody('GET', '/sized?x=1', [], 'hello'))

    expect(JSON.parse(response.body.toString())).toEqual({ contentLength: 5, query: 'x=1' })
    await expectHello(connection)
  })

  it('copies both for a stream producer that reads them after the handler returned', async () => {
    const app = createApp()
      .get('/feed', c =>
        c.stream(async stream => {
          await pause(5)
          await stream.write(`${c.req.query} ${c.req.contentType}`)
        }),
      )
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/feed?since=7', ['Content-Type: text/plain']),
    )

    expect(response.body.toString()).toBe('since=7 text/plain')
    await expectHello(connection)
  })

  it('copies the query for a task on a stream route whether the client sends GET or HEAD, so the method decides nothing', async () => {
    const reads: unknown[] = []
    const settled = Promise.withResolvers<void>()
    const app = createApp()
      .get('/feed', c => {
        void (async () => {
          await pause(5)
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
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('HEAD', '/feed?topic=a') + requestHead('GET', '/feed?topic=b'))
    const head = await connection.response({ method: 'HEAD' })
    const get = await connection.response()
    await settled.promise

    expect([head.status, get.status, get.body.toString()]).toEqual([200, 200, 'event'])
    expect(reads.sort()).toEqual(['topic=a', 'topic=b'])
    await expectHello(connection)
  })

  it('throws REQUEST_RELEASED to a task that first reads the query after the reply went out, and keeps a value read before', async () => {
    const outcome = Promise.withResolvers<unknown[]>()
    const app = createApp()
      .get('/audit', c => {
        const contentType = c.req.contentType
        void (async () => {
          await pause(5)
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
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/audit?page=2', ['Content-Type: text/plain']),
    )

    expect(response.body.toString()).toBe('text/plain')
    expect(await outcome.promise).toEqual(['text/plain', 'REQUEST_RELEASED'])
    await expectHello(connection)
  })
})
