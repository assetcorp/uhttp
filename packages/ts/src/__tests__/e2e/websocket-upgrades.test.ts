import { describe, expect, it } from 'vitest'
import { createApp, type Middleware } from '../../index.js'
import { openConnection, requestHead } from '../helpers/http-client.js'
import { expectClosedAfterReply } from '../helpers/replies.js'
import { memoryLogger, pause, start } from '../helpers/server.js'
import { expectedAccept, handshakeHeaders, rawHandshake, upgradeHead } from '../helpers/websocket.js'

const errorCode = (body: Buffer): unknown => JSON.parse(body.toString()).error.code

describe('a WebSocket upgrade from a client on the network', () => {
  it('switches protocols with the accept key, the first subprotocol, and the headers of the middleware', async () => {
    const app = createApp().ws(
      '/chat',
      async (c, next) => {
        await pause(5)
        c.header('x-session', 'abc')
        c.header('upgrade', 'h2c')
        await next()
      },
      {},
    )
    const server = await start(app)
    const headers = handshakeHeaders({ 'sec-websocket-protocol': 'chat.v2, chat.v1' })

    const reply = await rawHandshake(server.port, upgradeHead('/chat', headers))

    expect(reply.status).toBe(101)
    expect(reply.headers.get('sec-websocket-accept')).toEqual([expectedAccept(headers['sec-websocket-key'] ?? '')])
    expect(reply.headers.get('sec-websocket-protocol')).toEqual(['chat.v2'])
    expect(reply.headers.get('upgrade')).toEqual(['websocket'])
    expect(reply.headers.get('x-session')).toEqual(['abc'])
  })

  it('gives the same status and body as app.request() for every refused handshake, and keeps the connection open', async () => {
    const app = createApp().ws('/chat', {}).ws('/rooms/:id', {})
    const server = await start(app)
    const cases: [string, Record<string, string>, number, string][] = [
      ['/chat', handshakeHeaders({ origin: 'https://evil.example' }), 403, 'FORBIDDEN_ORIGIN'],
      ['/chat', handshakeHeaders({ origin: 'null' }), 403, 'FORBIDDEN_ORIGIN'],
      ['/chat', handshakeHeaders({ 'sec-websocket-version': '8' }), 426, 'UPGRADE_REQUIRED'],
      ['/chat', handshakeHeaders({ upgrade: 'h2c' }), 400, 'INVALID_UPGRADE'],
      ['/chat', handshakeHeaders({ connection: 'keep-alive' }), 400, 'INVALID_UPGRADE'],
      ['/chat', handshakeHeaders({ 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAAA!' }), 400, 'INVALID_UPGRADE'],
      ['/chat', handshakeHeaders({ 'sec-websocket-key': 'short' }), 426, 'UPGRADE_REQUIRED'],
      ['/chat', { host: 'localhost' }, 426, 'UPGRADE_REQUIRED'],
      ['/rooms/%E0%A4%A', handshakeHeaders(), 400, 'INVALID_PATH_PARAMETER'],
    ]
    const connection = await openConnection(server.port)

    for (const [path, headers, status, code] of cases) {
      const native = await connection.exchange(upgradeHead(path, headers))
      const matcher = await app.request(path, { headers })
      expect([path, headers, native.status, native.body.toString()]).toEqual([
        path,
        headers,
        matcher.status,
        await matcher.text(),
      ])
      expect([path, headers, native.status, errorCode(native.body)]).toEqual([path, headers, status, code])
    }
    expect(connection.state).toBe('open')
  })

  it('sends the supported version in a 426 to an upgrade, and the protocol in a 426 to a plain GET', async () => {
    const server = await start(createApp().ws('/chat', {}))
    const connection = await openConnection(server.port)

    const version = await connection.exchange(upgradeHead('/chat', handshakeHeaders({ 'sec-websocket-version': '8' })))
    const plain = await connection.exchange(requestHead('GET', '/chat'))

    expect(version.status).toBe(426)
    expect(version.headers.get('sec-websocket-version')).toEqual(['13'])
    expect(plain.status).toBe(426)
    expect(plain.headers.get('upgrade')).toEqual(['websocket'])
    expect(errorCode(plain.body)).toBe('UPGRADE_REQUIRED')
  })

  it('refuses an upgrade with a body, reads the body, and closes the connection after the 400', async () => {
    const handled: string[] = []
    const app = createApp().ws('/chat', {
      open: () => {
        handled.push('open')
      },
    })
    const server = await start(app)
    const connection = await openConnection(server.port)
    const headers = handshakeHeaders({ 'content-length': '11' })

    const response = await connection.exchange(`${upgradeHead('/chat', headers)}hello world`)

    expect(response.status).toBe(400)
    expect(errorCode(response.body)).toBe('INVALID_UPGRADE')
    await expectClosedAfterReply(connection, response)
    expect(handled).toEqual([])
  })

  it('upgrades nothing when the client leaves during an async middleware, and logs no error', async () => {
    const { entries, logger } = memoryLogger()
    const aborted = Promise.withResolvers<boolean>()
    const opened: string[] = []
    const slow: Middleware = async (c, next) => {
      const { signal } = c.req
      await pause(50)
      aborted.resolve(signal.aborted)
      await next()
    }
    const app = createApp({ logger }).ws('/chat', slow, {
      open: () => {
        opened.push('open')
      },
    })
    const server = await start(app)
    const connection = await openConnection(server.port)

    void connection.write(upgradeHead('/chat', handshakeHeaders()))
    await pause(10)
    connection.destroy()

    expect(await aborted.promise).toBe(true)
    await pause(20)
    expect(opened).toEqual([])
    expect(entries.filter(entry => entry.level === 'error')).toEqual([])
  })

  it('answers 503 and closes the connection when the middleware of an upgrade takes longer than the time limit of the route', async () => {
    const app = createApp().ws(
      '/chat',
      { timeoutMs: 30 },
      async (_c, next) => {
        await pause(200)
        await next()
      },
      {},
    )
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(upgradeHead('/chat', handshakeHeaders()))

    expect(response.status).toBe(503)
    expect(await connection.waitForClose()).toBe('closed')
  })
})
