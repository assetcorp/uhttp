import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createApp, type Server, serve } from '../../index.js'
import { type HttpConnection, openConnection, requestHead, requestWithBody } from '../helpers/http-client.js'
import { pause } from '../helpers/server.js'
import { handshakeHeaders, openSocket, upgradeHead } from '../helpers/websocket.js'

const HOST = '127.0.0.1'
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR2'] as const

interface Held {
  readonly entered: Promise<void>
  release(): void
}

function holdingApp() {
  const holds: PromiseWithResolvers<void>[] = []
  const entries: PromiseWithResolvers<void>[] = []
  const app = createApp()
    .get('/name', c => c.text('named'))
    .get('/slow', async c => {
      entries.shift()?.resolve()
      const hold = Promise.withResolvers<void>()
      holds.push(hold)
      await hold.promise
      return c.text('finished')
    })
    .ws('/live', {})
  const hold = (): Held => {
    const entered = Promise.withResolvers<void>()
    entries.push(entered)
    return {
      entered: entered.promise,
      release: () => {
        for (const waiting of holds.splice(0)) waiting.resolve()
      },
    }
  }
  return { app, hold }
}

async function servedPort(server: Server): Promise<number> {
  if (server.port === undefined) throw new Error('The server listens on no port.')
  return server.port
}

async function slowRequest(port: number, held: Held): Promise<HttpConnection> {
  const connection = await openConnection(port)
  void connection.write(requestHead('GET', '/slow'))
  await held.entered
  return connection
}

async function idleConnection(port: number): Promise<HttpConnection> {
  const connection = await openConnection(port)
  const response = await connection.exchange(requestHead('GET', '/name'))
  expect(response.status).toBe(200)
  return connection
}

function settledFlag(promise: Promise<void>): () => boolean {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  return () => settled
}

function connectRefused(port: number): Promise<string> {
  return new Promise(resolve => {
    const socket = connect({ port, host: HOST })
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', error => resolve(String(Reflect.get(error, 'code'))))
  })
}

describe('server.close() on the main thread', () => {
  it('lets a request in progress finish with Connection: close, and closes an idle connection once no request is left', async () => {
    const { app, hold } = holdingApp()
    const server = await serve({ app, port: 0, host: HOST })
    const port = await servedPort(server)
    const held = hold()
    const busy = await slowRequest(port, held)
    const idle = await idleConnection(port)

    const closing = server.close()
    const closed = settledFlag(closing)
    await pause(150)

    expect(closed()).toBe(false)
    expect(idle.state).toBe('open')
    expect(await connectRefused(port)).toBe('ECONNREFUSED')
    held.release()
    const response = await busy.response()
    expect(response.status).toBe(200)
    expect(response.body.toString()).toBe('finished')
    expect(response.headers.get('connection')).toEqual(['close'])
    expect(await busy.waitForClose()).toBe('closed')
    expect(await idle.waitForClose(500)).toBe('closed')
    await closing
  })

  it('answers a new request on an open connection with 503 and Connection: close while a request is in progress', async () => {
    const { app, hold } = holdingApp()
    const server = await serve({ app, port: 0, host: HOST })
    const port = await servedPort(server)
    const held = hold()
    await slowRequest(port, held)
    const plain = await idleConnection(port)
    const withBody = await idleConnection(port)
    const upgrading = await idleConnection(port)

    const closing = server.close()
    const refused = await plain.exchange(requestHead('GET', '/name'))
    const refusedWithBody = await withBody.exchange(requestWithBody('POST', '/name', [], 'x'.repeat(4_096)))
    const refusedUpgrade = await upgrading.exchange(upgradeHead('/live', handshakeHeaders()))

    for (const response of [refused, refusedWithBody, refusedUpgrade]) {
      expect(response.status).toBe(503)
      expect(response.headers.get('connection')).toEqual(['close'])
      expect(JSON.parse(response.body.toString())).toEqual({
        error: { code: 'SERVER_CLOSING', message: 'The server is closing, so send the request again.' },
      })
    }
    expect(await plain.waitForClose()).toBe('closed')
    expect(await withBody.finish()).toBe('closed')
    expect(await upgrading.waitForClose()).toBe('closed')
    held.release()
    await closing
  })

  it('sends the close code 1001 to every WebSocket client', async () => {
    const { app } = holdingApp()
    const server = await serve({ app, port: 0, host: HOST })
    const sockets = await Promise.all([0, 1].map(async () => openSocket(await servedPort(server), '/live')))

    await server.close()

    expect((await Promise.all(sockets.map(socket => socket.closed))).map(closed => closed.code)).toEqual([1001, 1001])
  })

  it('closes every remaining connection once the grace period ends', async () => {
    const { app, hold } = holdingApp()
    const server = await serve({ app, port: 0, host: HOST, gracePeriodMs: 300 })
    const busy = await slowRequest(await servedPort(server), hold())
    const startedAt = Date.now()

    await server.close()

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(280)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(['closed', 'reset']).toContain(await busy.waitForClose())
  })

  it('waits 10 seconds for a request in progress by default before it closes the connection', async () => {
    const { app, hold } = holdingApp()
    const server = await serve({ app, port: 0, host: HOST })
    const busy = await slowRequest(await servedPort(server), hold())
    const startedAt = Date.now()

    await server.close()

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_900)
    expect(Date.now() - startedAt).toBeLessThan(11_500)
    expect(['closed', 'reset']).toContain(await busy.waitForClose())
  }, 20_000)

  it('returns the same promise from a second call', async () => {
    const server = await serve({ app: holdingApp().app, port: 0, host: HOST })

    const first = server.close()

    expect(server.close()).toBe(first)
    await first
  })

  it('installs no signal handler', async () => {
    const before = SIGNALS.map(signal => process.listenerCount(signal))
    const server = await serve({ app: holdingApp().app, port: 0, host: HOST })

    expect(SIGNALS.map(signal => process.listenerCount(signal))).toEqual(before)
    await server.close()
  })
})
