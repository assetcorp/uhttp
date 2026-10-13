import { describe, expect, it } from 'vitest'
import { createApp, type Middleware, UhttpError } from '../../../index.js'
import { pause } from '../../helpers/server.js'
import { expectedAccept, handshakeHeaders } from '../../helpers/websocket.js'

const errorOf = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) return undefined
  const error: unknown = Reflect.get(body, 'error')
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

describe('an upgrade request through app.request()', () => {
  it('receives the 101 with the accept key of RFC 6455 and the first subprotocol that the client offered', async () => {
    const app = createApp().ws('/chat', {})
    const headers = handshakeHeaders({ 'sec-websocket-protocol': 'chat.v2, chat.v1' })

    const response = await app.request('/chat', { headers })

    expect(response.status).toBe(101)
    expect(response.headers.get('upgrade')).toBe('websocket')
    expect(response.headers.get('connection')).toBe('Upgrade')
    expect(response.headers.get('sec-websocket-accept')).toBe(expectedAccept(headers['sec-websocket-key'] ?? ''))
    expect(response.headers.get('sec-websocket-protocol')).toBe('chat.v2')
  })

  it('accepts a page on the host of the request, whatever the case of the host and its default port', async () => {
    const app = createApp().ws('/chat', {})

    for (const [host, origin] of [
      ['chat.example.com', 'https://chat.example.com'],
      ['Chat.Example.com:443', 'https://chat.example.com'],
      ['chat.example.com:8080', 'http://chat.example.com:8080'],
      ['[::1]:3000', 'http://[::1]:3000'],
    ] as const) {
      const response = await app.request('/chat', { headers: handshakeHeaders({ host, origin }) })
      expect([host, response.status]).toEqual([host, 101])
    }
  })

  it('accepts a client that sends no origin, as a client outside a browser does', async () => {
    const app = createApp().ws('/chat', {})

    expect((await app.request('/chat', { headers: handshakeHeaders() })).status).toBe(101)
  })

  it('refuses the null origin, a page on another host, port, or scheme, and a malformed origin', async () => {
    const app = createApp().ws('/chat', {})

    for (const origin of [
      'null',
      'https://evil.example',
      'https://chat.example.com.evil.example',
      'https://chat.example.com',
      'http://chat.example.com:9000',
      'https://chat.example.com:8443:1',
      'chrome-extension://abcdef',
      'https://chat.example.com/',
      'not a url',
    ]) {
      const response = await app.request('/chat', {
        headers: handshakeHeaders({ host: 'chat.example.com:8443', origin }),
      })
      expect([origin, response.status, await errorOf(response)]).toEqual([origin, 403, 'FORBIDDEN_ORIGIN'])
    }
  })

  it('refuses a host with credentials or a path, which a browser never sends', async () => {
    const app = createApp().ws('/chat', {})

    for (const host of ['user@chat.example.com', 'chat.example.com/admin']) {
      const response = await app.request('/chat', {
        headers: handshakeHeaders({ host, origin: 'https://chat.example.com' }),
      })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).not.toBe(101)
    }
  })

  it('accepts only the origins in the origins list of a route that sets one', async () => {
    const app = createApp().ws('/chat', { origins: ['https://app.example.com', 'http://localhost:5173'] })

    const listed = await app.request('/chat', {
      headers: handshakeHeaders({ host: 'api.example.com', origin: 'https://app.example.com' }),
    })
    const local = await app.request('/chat', {
      headers: handshakeHeaders({ host: 'api.example.com', origin: 'http://localhost:5173' }),
    })
    const ownHost = await app.request('/chat', {
      headers: handshakeHeaders({ host: 'api.example.com', origin: 'https://api.example.com' }),
    })

    expect([listed.status, local.status, ownHost.status]).toEqual([101, 101, 403])
  })

  it('answers 426 with the supported version to a client that asks for another version', async () => {
    const app = createApp().ws('/chat', {})

    for (const version of ['8', '14', '']) {
      const response = await app.request('/chat', { headers: handshakeHeaders({ 'sec-websocket-version': version }) })
      expect(response.status).toBe(426)
      expect(response.headers.get('sec-websocket-version')).toBe('13')
      expect(await errorOf(response)).toBe('UPGRADE_REQUIRED')
    }
  })

  it('answers 400 to an upgrade without upgrade: websocket or connection: upgrade, or with a malformed key', async () => {
    const app = createApp().ws('/chat', {})

    for (const overrides of [
      { upgrade: 'h2c' },
      { connection: 'keep-alive' },
      { 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAAA!' },
      { 'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAAAA' },
    ]) {
      const response = await app.request('/chat', { headers: handshakeHeaders(overrides) })
      expect([overrides, response.status, await errorOf(response)]).toEqual([overrides, 400, 'INVALID_UPGRADE'])
    }
  })

  it('accepts the tokens in any case and among other tokens, across several header lines', async () => {
    const app = createApp().ws('/chat', {})
    const { upgrade: _upgrade, connection: _connection, ...rest } = handshakeHeaders()

    const response = await app.request('/chat', {
      headers: [
        ...Object.entries(rest),
        ['Upgrade', 'WebSocket'],
        ['Connection', 'keep-alive'],
        ['Connection', 'UPGRADE'],
      ],
    })

    expect(response.status).toBe(101)
  })

  it('refuses an upgrade with a body and closes the connection after the 400', async () => {
    const app = createApp().ws('/chat', {})

    const response = await app.request('/chat', { headers: handshakeHeaders(), body: 'hello' })

    expect(response.status).toBe(400)
    expect(response.headers.get('connection')).toBe('close')
    expect(await errorOf(response)).toBe('INVALID_UPGRADE')
  })

  it('treats a key of another length as a GET without an upgrade, as uWebSockets.js does', async () => {
    const app = createApp().ws('/chat', {})

    const response = await app.request('/chat', { headers: handshakeHeaders({ 'sec-websocket-key': 'c2hvcnQ=' }) })

    expect(response.status).toBe(426)
  })

  it('lets a middleware refuse the upgrade with its own status, after an await', async () => {
    const auth: Middleware = {
      headers: ['authorization'],
      handle: async (c, next) => {
        await pause(1)
        if (c.req.header('authorization') !== 'Bearer secret') throw new UhttpError('NOT_FOUND', 'No such room.')
        await next()
      },
    }
    const app = createApp().ws('/rooms/:id', auth, {})

    const refused = await app.request('/rooms/7', { headers: handshakeHeaders() })
    const accepted = await app.request('/rooms/7', {
      headers: handshakeHeaders({ authorization: 'Bearer secret' }),
    })

    expect(refused.status).toBe(404)
    expect(accepted.status).toBe(101)
  })

  it('passes the refusal of a handshake through the middleware of the app, the group, and the route', async () => {
    const seen: string[] = []
    const watch =
      (name: string): Middleware =>
      async (c, next) => {
        await next()
        seen.push(`${name} ${c.reply?.status}`)
      }
    const app = createApp().use(watch('app'))
    app.group('/live', watch('group')).ws('/chat', watch('route'), {})

    await app.request('/live/chat', { headers: handshakeHeaders({ origin: 'null' }) })
    await app.request('/live/chat', { headers: handshakeHeaders() })

    expect(seen).toEqual(['route 403', 'group 403', 'app 403', 'route 101', 'group 101', 'app 101'])
  })

  it('sends the headers that a middleware set with the 101', async () => {
    const app = createApp().ws(
      '/chat',
      async (c, next) => {
        c.header('x-session', 'abc')
        c.header('sec-websocket-accept', 'forged')
        await next()
      },
      {},
    )
    const headers = handshakeHeaders()

    const response = await app.request('/chat', { headers })

    expect(response.headers.get('x-session')).toBe('abc')
    expect(response.headers.get('sec-websocket-accept')).toBe(expectedAccept(headers['sec-websocket-key'] ?? ''))
  })

  it('sends the reply of a middleware that replaces the 101', async () => {
    const app = createApp().ws(
      '/chat',
      async (c, next) => {
        await next()
        return c.json({ busy: true }, 503)
      },
      {},
    )

    const response = await app.request('/chat', { headers: handshakeHeaders() })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ busy: true })
  })

  it('answers 400 for a path parameter that fails to decode', async () => {
    const app = createApp().ws('/rooms/:id', {})

    const response = await app.request('/rooms/%E0%A4%A', { headers: handshakeHeaders() })

    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('INVALID_PATH_PARAMETER')
  })
})
