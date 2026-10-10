import { describe, expect, it } from 'vitest'
import { createApp, serve, UhttpError } from '../../index.js'
import { openConnection, requestHead, send } from '../helpers/http-client.js'
import { errorBody, expectHello } from '../helpers/replies.js'
import { memoryLogger, pause, start } from '../helpers/server.js'

const INTERNAL_ERROR = errorBody('INTERNAL_ERROR', 'The request failed.')

describe('connections to a server from serve()', () => {
  it('serves a GET route on the port that the operating system assigns for port 0, over a connection that it keeps open', async () => {
    const server = await start(createApp().get('/hello', c => c.text('Hello, World!')))
    const connection = await openConnection(server.port)

    const first = await connection.exchange(requestHead('GET', '/hello'))
    const second = await connection.exchange(requestHead('GET', '/hello'))

    expect(server.port).toBeGreaterThan(0)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toEqual(['text/plain; charset=UTF-8'])
    expect(first.headers.get('content-length')).toEqual(['13'])
    expect(first.body.toString()).toBe('Hello, World!')
    expect([second.status, second.body.toString()]).toEqual([200, 'Hello, World!'])
  })

  it('answers requests that a client pipelines on one connection in the order that it sent them', async () => {
    const app = createApp()
      .get('/first', c => c.text('first'))
      .get('/second', c => c.json({ order: 2 }))
      .get('/third', c => c.text('third', 201))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('GET', '/first') + requestHead('GET', '/second') + requestHead('GET', '/third'))
    const responses = [await connection.response(), await connection.response(), await connection.response()]

    expect(responses.map(response => [response.status, response.body.toString()])).toEqual([
      [200, 'first'],
      [200, '{"order":2}'],
      [201, 'third'],
    ])
    await expectHello(connection)
  })

  it('closes the connection in place of answering pipelined requests out of order while the first reply is still pending', async () => {
    const handled: string[] = []
    const app = createApp()
      .get('/slow', async c => {
        handled.push('slow')
        await pause(50)
        return c.text('slow')
      })
      .get('/fast', c => {
        handled.push('fast')
        return c.text('fast')
      })
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('GET', '/slow') + requestHead('GET', '/fast'))
    const bodies: string[] = []
    for (let index = 0; index < 2; index++) {
      const response = await connection.response().catch(() => undefined)
      if (response === undefined) break
      bodies.push(response.body.toString())
    }
    await pause(100)

    expect(['slow', 'fast'].slice(0, bodies.length)).toEqual(bodies)
    expect(['slow', 'fast'].slice(0, handled.length)).toEqual(handled)
    expect(connection.state).not.toBe('open')
  })

  it('closes the connection after the reply when the client sends Connection: close', async () => {
    const server = await start(createApp().get('/hello', c => c.text('Hello')))

    const { connection, response } = await send(server.port, requestHead('GET', '/hello', ['Connection: close']))

    expect([response.status, response.body.toString()]).toEqual([200, 'Hello'])
    expect(await connection.waitForClose()).toBe('closed')
  })

  it('sends the reply of a handler that awaits before it returns', async () => {
    const app = createApp()
      .get('/slow', async c => {
        await pause(5)
        return c.json({ ready: true }, 202)
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', '/slow'))

    expect(response.status).toBe(202)
    expect(response.headers.get('content-type')).toEqual(['application/json'])
    expect(response.body.toString()).toBe('{"ready":true}')
    await expectHello(connection)
  })

  it('passes the method, the path, and the query string from the network to the handler, over a connection that it keeps open', async () => {
    const server = await start(
      createApp()
        .get('/search', c => c.json({ ...c.req }))
        .get('/hello', c => c.text('Hello')),
    )
    const connection = await openConnection(server.port)

    const bodies: unknown[] = []
    for (const target of ['/search?q=uhttp&page=2', '/search', '/search?']) {
      bodies.push(JSON.parse((await connection.exchange(requestHead('GET', target))).body.toString()))
    }

    expect(bodies).toEqual([
      { method: 'GET', path: '/search', query: 'q=uhttp&page=2' },
      { method: 'GET', path: '/search', query: '' },
      { method: 'GET', path: '/search', query: '' },
    ])
    await expectHello(connection)
  })

  it('returns the same JSON 404 as app.request() for a path that has no route, and keeps the connection open', async () => {
    const app = createApp().get('/hello', c => c.text('Hello'))
    const server = await start(app)

    const { connection, response } = await send(server.port, requestHead('GET', '/missing'))
    const tested = await app.request('/missing')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toEqual(['application/json'])
    expect(response.body.toString()).toBe(await tested.text())
    await expectHello(connection)
  })

  it('sends a 204 with no body and no length, so that the next response on the connection parses', async () => {
    const app = createApp()
      .get('/empty', c => c.text('ignored', 204))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(requestHead('GET', '/empty') + requestHead('GET', '/hello'))
    const empty = await connection.response()
    const next = await connection.response()

    expect([empty.status, empty.framing, empty.body.length]).toEqual([204, 'none', 0])
    expect(empty.headers.has('content-length')).toBe(false)
    expect([next.status, next.body.toString()]).toEqual([200, 'Hello'])
  })

  it('returns a 500 with a generic message when a handler throws or rejects, and keeps the connection open', async () => {
    const app = createApp()
      .get('/throws', () => {
        throw new Error('secret')
      })
      .get('/rejects', async () => {
        await pause(1)
        throw new Error('secret')
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    for (const path of ['/throws', '/rejects']) {
      const response = await connection.exchange(requestHead('GET', path))
      expect([response.status, response.body.toString()]).toEqual([500, INTERNAL_ERROR])
    }
    await expectHello(connection)
  })

  it('serves the next client after a client disconnects before its handler returns, and logs no error', async () => {
    const { entries, logger } = memoryLogger()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const answered = Promise.withResolvers<void>()
    const app = createApp({ logger })
      .get('/slow', async c => {
        started.resolve()
        await release.promise
        answered.resolve()
        return c.text('late')
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const abandoned = await openConnection(server.port)

    void abandoned.write(requestHead('GET', '/slow'))
    await started.promise
    abandoned.destroy()
    await pause(50)
    release.resolve()
    await answered.promise
    await pause(10)

    await expectHello(await openConnection(server.port))
    expect(entries).toEqual([])
  })

  it('closes its open connections and refuses new ones once it closes', async () => {
    const server = await start(createApp().get('/hello', c => c.text('Hello')))
    const connection = await openConnection(server.port)
    await expectHello(connection)

    await server.close()

    expect(await connection.waitForClose()).toBe('closed')
    await expect(openConnection(server.port)).rejects.toThrow()
  })

  it('returns the same promise from a second call to close()', async () => {
    const server = await start(createApp())

    expect(server.close()).toBe(server.close())
  })

  it('listens on every interface when you leave out the host', async () => {
    const server = await serve({ app: createApp().get('/hello', c => c.text('Hello')), port: 0 })

    try {
      await expectHello(await openConnection(server.port))
    } finally {
      await server.close()
    }
  })

  it('throws for a port outside the TCP range of 0 to 65535', async () => {
    for (const port of [-1, 65_536, 1.5, Number.NaN]) {
      await expect(serve({ app: createApp(), port })).rejects.toMatchObject({ code: 'INVALID_SERVE_OPTIONS' })
    }
  })

  it('rejects with a typed error when the operating system cannot bind the address', async () => {
    await expect(serve({ app: createApp(), port: 0, host: '203.0.113.1' })).rejects.toBeInstanceOf(UhttpError)
  })
})
