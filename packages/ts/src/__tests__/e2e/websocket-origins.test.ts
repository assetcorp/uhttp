import { describe, expect, it } from 'vitest'
import { createApp, type Middleware, type OriginCheck, type WebSocketRoute } from '../../index.js'
import { openConnection } from '../helpers/http-client.js'
import { memoryLogger, pause, start } from '../helpers/server.js'
import { bodyOf, handshakeHeaders, openSocket, rawHandshake, upgradeHead } from '../helpers/websocket.js'

const APP_ORIGIN = 'https://app.example.com'
const ACCESS_TOKEN = 'token-for-the-socket'

const echo: WebSocketRoute = {
  message: (socket, message) => {
    socket.send(message)
  },
}

const errorCode = (body: string): unknown => JSON.parse(body).error.code

async function echoes(port: number, path: string, origin: string | undefined): Promise<string | Uint8Array> {
  const headers: Record<string, string> = origin === undefined ? {} : { origin }
  const client = await openSocket(port, path, { headers })
  client.send(`hello from ${origin ?? 'no origin'}`)
  return client.nextMessage()
}

const requireToken: Middleware = (c, next) => {
  const token = new URLSearchParams(c.req.query).get('token')
  if (token !== ACCESS_TOKEN) return c.json({ error: 'Send a valid token.' }, 401)
  return next()
}

describe('the origin check of a WebSocket route, through a client on the network', () => {
  it('opens a socket from every origin, null included, on a route that accepts every origin, while its token middleware refuses a client without a token', async () => {
    const app = createApp().ws('/live', requireToken, { ...echo, origins: '*' })
    const server = await start(app)
    const path = `/live?token=${ACCESS_TOKEN}`

    for (const origin of ['null', 'https://evil.example', 'chrome-extension://abcdef', 'not a url', undefined]) {
      expect([origin, await echoes(server.port, path, origin)]).toEqual([origin, `hello from ${origin ?? 'no origin'}`])
    }
    await expect(openSocket(server.port, '/live', { headers: { origin: 'null' } })).rejects.toThrow()
    const refused = await rawHandshake(server.port, upgradeHead('/live', handshakeHeaders({ origin: 'null' })))
    expect(refused.status).toBe(401)
  })

  it('opens a socket for each origin that an async check accepts, and refuses every other origin with a 403 without passing null or another scheme to the check', async () => {
    const seen: string[] = []
    const check: OriginCheck = async (origin, c) => {
      seen.push(`${origin} ${c.req.path}`)
      await pause(5)
      return origin === APP_ORIGIN
    }
    const app = createApp().ws('/chat', { ...echo, origins: check })
    const server = await start(app)

    expect(await echoes(server.port, '/chat', APP_ORIGIN)).toBe(`hello from ${APP_ORIGIN}`)
    expect(await echoes(server.port, '/chat', undefined)).toBe('hello from no origin')
    for (const origin of ['https://evil.example', 'null', 'chrome-extension://abcdef', `${APP_ORIGIN}/`]) {
      await expect(openSocket(server.port, '/chat', { headers: { origin } })).rejects.toThrow()
      const reply = await rawHandshake(server.port, upgradeHead('/chat', handshakeHeaders({ origin })))
      expect([origin, reply.status, errorCode(await bodyOf(reply))]).toEqual([origin, 403, 'FORBIDDEN_ORIGIN'])
    }
    expect(seen).toEqual([`${APP_ORIGIN} /chat`, 'https://evil.example /chat', 'https://evil.example /chat'])
  })

  it('refuses the upgrade with a 500 and logs the error when the check throws, and keeps the connection open', async () => {
    const { entries, logger } = memoryLogger()
    const check: OriginCheck = () => {
      throw new Error('The origin store is down.')
    }
    const app = createApp({ logger }).ws('/chat', { ...echo, origins: check })
    const server = await start(app)
    const connection = await openConnection(server.port)

    await expect(openSocket(server.port, '/chat', { headers: { origin: APP_ORIGIN } })).rejects.toThrow()
    const reply = await connection.exchange(upgradeHead('/chat', handshakeHeaders({ origin: APP_ORIGIN })))

    expect(reply.status).toBe(500)
    expect(connection.state).toBe('open')
    expect(entries.filter(entry => entry.level === 'error')).toHaveLength(2)
  })

  it('answers 503 and closes the connection when the check takes longer than the time limit of the route', async () => {
    const check: OriginCheck = () => new Promise(() => undefined)
    const app = createApp().ws('/chat', { timeoutMs: 30 }, { ...echo, origins: check })
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(upgradeHead('/chat', handshakeHeaders({ origin: APP_ORIGIN })))

    expect(response.status).toBe(503)
    expect(await connection.waitForClose()).toBe('closed')
  })

  it('opens no socket and logs no error when the client leaves before the check accepts its origin', async () => {
    const { entries, logger } = memoryLogger()
    const decided = Promise.withResolvers<boolean>()
    const opened: string[] = []
    const check: OriginCheck = async (_origin, c) => {
      const { signal } = c.req
      await pause(50)
      decided.resolve(signal.aborted)
      return true
    }
    const app = createApp({ logger }).ws('/chat', {
      origins: check,
      open: () => {
        opened.push('open')
      },
    })
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(upgradeHead('/chat', handshakeHeaders({ origin: APP_ORIGIN })))
    await pause(10)
    connection.destroy()

    expect(await decided.promise).toBe(true)
    await pause(20)
    expect(opened).toEqual([])
    expect(entries.filter(entry => entry.level === 'error')).toEqual([])
  })

  it('keeps refusing null on a route with the default check or a list, and opens a socket from the host of the request or a listed origin', async () => {
    const app = createApp()
      .ws('/own', echo)
      .ws('/listed', { ...echo, origins: [APP_ORIGIN] })
    const server = await start(app)
    const ownOrigin = `http://127.0.0.1:${server.port}`

    expect(await echoes(server.port, '/own', ownOrigin)).toBe(`hello from ${ownOrigin}`)
    expect(await echoes(server.port, '/listed', APP_ORIGIN)).toBe(`hello from ${APP_ORIGIN}`)
    for (const [path, origin] of [
      ['/own', 'null'],
      ['/listed', 'null'],
      ['/own', 'https://evil.example'],
      ['/listed', ownOrigin],
    ] as const) {
      await expect(openSocket(server.port, path, { headers: { origin } })).rejects.toThrow()
      const reply = await rawHandshake(server.port, upgradeHead(path, handshakeHeaders({ origin })))
      expect([path, origin, reply.status]).toEqual([path, origin, 403])
    }
  })
})
