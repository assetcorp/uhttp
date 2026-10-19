import { describe, expect, it } from 'vitest'
import { createApp, UhttpError } from '../../index.js'
import { openConnection, requestHead, requestWithBody } from '../helpers/http-client.js'
import { errorBody, expectHello } from '../helpers/replies.js'
import { memoryLogger, pause, start } from '../helpers/server.js'

const API_KEY = 'key-7f3a'
const REFUSED = JSON.stringify({ error: 'unknown key' })

function keyedApp(wait: () => Promise<void> = () => Promise.resolve()) {
  const handled: string[] = []
  const app = createApp()
    .use({
      headers: ['x-api-key'],
      before: c => (c.req.header('x-api-key') === API_KEY ? undefined : c.json({ error: 'unknown key' }, 401)),
    })
    .use({
      headers: ['x-slow'],
      before: c => (c.req.header('x-slow') === undefined ? undefined : wait()),
    })
    .get('/hello', c => c.text('Hello'))
    .post('/orders', async c => {
      handled.push('orders')
      return c.json({ bytes: (await c.req.body.bytes()).byteLength }, 201)
    })
  return { app, handled }
}

describe('replies that a before function sends', () => {
  it('answers 401 to a POST whose whole body the client sent, never calls the handler, and serves the next request', async () => {
    const { app, handled } = keyedApp()
    const server = await start(app)
    const connection = await openConnection(server.port)

    const refused = await connection.exchange(
      requestWithBody('POST', '/orders', ['Content-Type: application/json', 'X-Api-Key: wrong'], '{"item":"tea"}'),
    )
    const accepted = await connection.exchange(
      requestWithBody('POST', '/orders', ['Content-Type: application/json', `X-Api-Key: ${API_KEY}`], '{"item":"tea"}'),
    )

    expect([refused.status, refused.body.toString()]).toEqual([401, REFUSED])
    expect([accepted.status, accepted.body.toString()]).toEqual([201, JSON.stringify({ bytes: 14 })])
    expect(handled).toEqual(['orders'])
    expect(connection.state).toBe('open')
  })

  it('answers each of several pipelined requests in order when a before function refuses some of them', async () => {
    const { app } = keyedApp()
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(
      requestHead('GET', '/hello', [`X-Api-Key: ${API_KEY}`]) +
        requestHead('GET', '/hello') +
        requestHead('GET', '/hello', [`X-Api-Key: ${API_KEY}`]),
    )
    const statuses = [await connection.response(), await connection.response(), await connection.response()].map(
      response => response.status,
    )

    expect(statuses).toEqual([200, 401, 200])
    expect(await connection.finish()).toBe('closed')
  })

  it('waits for a before function that returns a promise, while the body arrives, and then calls the handler', async () => {
    const { app } = keyedApp(() => pause(30))
    const server = await start(app)
    const connection = await openConnection(server.port)
    const body = Buffer.alloc(8192, 0x62)
    const request = requestWithBody('POST', '/orders', [`X-Api-Key: ${API_KEY}`, 'X-Slow: yes'], body)
    const split = request.length - 4096

    void connection.write(request.subarray(0, split))
    await pause(10)
    void connection.write(request.subarray(split))
    const response = await connection.response()

    expect([response.status, response.body.toString()]).toEqual([201, JSON.stringify({ bytes: 8192 })])
    expect(connection.state).toBe('open')
  })

  it('serves the next client when a client disconnects while a before function waits, and logs nothing', async () => {
    const { entries, logger } = memoryLogger()
    const waiting = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const app = createApp({ logger })
      .use({
        headers: ['x-slow'],
        before: async c => {
          if (c.req.header('x-slow') === undefined) return
          waiting.resolve()
          await release.promise
        },
      })
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const abandoned = await openConnection(server.port)

    void abandoned.write(requestHead('GET', '/hello', ['X-Slow: yes']))
    await waiting.promise
    abandoned.destroy()
    await pause(10)
    release.resolve()
    await pause(10)

    await expectHello(await openConnection(server.port))
    expect(entries).toEqual([])
  })

  it('answers with the error that a before function throws, and keeps the connection open', async () => {
    const app = createApp()
      .use({
        before() {
          throw new UhttpError('NOT_FOUND', 'The shop has closed this catalogue.')
        },
      })
      .get('/catalogue', c => c.text('catalogue'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const first = await connection.exchange(requestHead('GET', '/catalogue'))
    const second = await connection.exchange(requestHead('GET', '/catalogue'))

    for (const response of [first, second]) {
      expect([response.status, response.body.toString()]).toEqual([
        404,
        errorBody('NOT_FOUND', 'The shop has closed this catalogue.'),
      ])
    }
    expect(connection.state).toBe('open')
  })
})
