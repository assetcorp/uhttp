import { describe, expect, it } from 'vitest'
import { createApp, serve } from '../../index.js'
import { rateLimit } from '../../middleware/rate-limit/index.js'
import { SHARED_LIMIT } from '../fixtures/rate-limit-app.js'
import { type HttpConnection, openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import type { ReceivedResponse } from '../helpers/http-response.js'
import { errorBody } from '../helpers/replies.js'
import { start, track } from '../helpers/server.js'

const fixture = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url)
const REQUESTS_PER_THREAD = 8
const STATE = /^"default";r=(\d+);t=(\d+)$/

async function threadOf(connection: HttpConnection): Promise<string> {
  const response = await connection.exchange(requestHead('GET', '/thread'))
  return response.body.toString()
}

async function connectionsOnTwoThreads(port: number, attempts = 40): Promise<HttpConnection[]> {
  const found = new Map<string, HttpConnection>()
  for (let attempt = 0; attempt < attempts && found.size < 2; attempt++) {
    const connection = await openConnection(port)
    const thread = await threadOf(connection)
    if (found.has(thread)) connection.destroy()
    else found.set(thread, connection)
  }
  if (found.size < 2) throw new Error('No two connections reached different threads.')
  return [...found.values()]
}

function remainingOf(response: ReceivedResponse): number {
  const match = STATE.exec(response.headers.get('ratelimit')?.[0] ?? '')
  if (match === null) throw new Error(`The response carries no RateLimit header: ${response.headers.get('ratelimit')}`)
  return Number(match[1])
}

function limitedApp(limit: number) {
  return createApp()
    .use(rateLimit({ limit, windowMs: 60_000 }))
    .post('/orders', async c => c.text(Buffer.from(await c.req.body.bytes()).toString()))
    .get('/hello', c => c.text('Hello'))
}

describe('rate limits over the network', () => {
  it('counts the requests of one client across two worker threads, and serves exactly the limit', async () => {
    const server = track(await serve({ app: fixture('rate-limit-app.js'), port: 0, host: '127.0.0.1', threads: 2 }))
    const connections = await connectionsOnTwoThreads(server.port)

    const responses: ReceivedResponse[] = []
    for (let round = 0; round < REQUESTS_PER_THREAD; round++) {
      for (const connection of connections) responses.push(await connection.exchange(requestHead('GET', '/limited')))
    }
    const admitted = responses.filter(response => response.status === 200)
    const refused = responses.filter(response => response.status === 429)

    expect(admitted).toHaveLength(SHARED_LIMIT)
    expect(refused).toHaveLength(2 * REQUESTS_PER_THREAD - SHARED_LIMIT)
    expect(new Set(admitted.map(response => response.body.toString())).size).toBe(2)
    expect(admitted.map(remainingOf)).toEqual(
      Array.from({ length: SHARED_LIMIT }, (_, index) => SHARED_LIMIT - 1 - index),
    )
    for (const response of refused) {
      expect(remainingOf(response)).toBe(0)
      expect(response.headers.get('retry-after')).toHaveLength(1)
    }
    for (const connection of connections) expect(connection.state).toBe('open')
  })

  it('rejects a POST over the limit with its body, and keeps the connection open for the next request', async () => {
    const server = await start(limitedApp(1))
    const connection = await openConnection(server.port)

    const first = await connection.exchange(
      requestWithBody('POST', '/orders', ['Content-Type: text/plain'], 'first order'),
    )
    const second = await connection.exchange(
      requestWithBody('POST', '/orders', ['Content-Type: text/plain'], 'second order'),
    )

    expect([first.status, first.body.toString()]).toEqual([200, 'first order'])
    expect(second.status).toBe(429)
    expect(second.body.toString()).toBe(
      errorBody('RATE_LIMITED', 'The client sent more requests than the limit of 1 for one window.'),
    )
    expect(second.headers.get('ratelimit-policy')).toEqual(['"default";q=1;w=60'])
    const retry = Number(second.headers.get('retry-after')?.[0])
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(60)
    expect(connection.state).toBe('open')
  })

  it('counts every connection of one client address as one client', async () => {
    const server = await start(limitedApp(2))

    const statuses: number[] = []
    for (let index = 0; index < 4; index++) {
      const { connection, response } = await send(server.port, requestHead('GET', '/hello'))
      statuses.push(response.status)
      connection.destroy()
    }

    expect(statuses).toEqual([200, 200, 429, 429])
  })

  it('serves a client with another key from a declared header while it rejects the first one', async () => {
    const server = await start(
      createApp()
        .use(
          rateLimit({
            limit: 1,
            windowMs: 60_000,
            headers: ['x-tenant'],
            key: c => c.req.header('x-tenant') ?? 'anonymous',
          }),
        )
        .get('/hello', c => c.text('Hello')),
    )
    const connection = await openConnection(server.port)

    const first = await connection.exchange(requestHead('GET', '/hello', ['X-Tenant: shoes']))
    const refused = await connection.exchange(requestHead('GET', '/hello', ['X-Tenant: shoes']))
    const other = await connection.exchange(requestHead('GET', '/hello', ['X-Tenant: hats']))

    expect([first.status, refused.status, other.status]).toEqual([200, 429, 200])
    expect(connection.state).toBe('open')
  })
})
