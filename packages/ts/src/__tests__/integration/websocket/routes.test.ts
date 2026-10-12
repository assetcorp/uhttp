import { describe, expect, it } from 'vitest'
import { createApp, type WebSocketRoute } from '../../../index.js'

function addRoute(route: unknown, ...stack: unknown[]): () => void {
  return () => {
    const app = createApp()
    Reflect.apply(app.ws, app, ['/chat', ...stack, route])
  }
}

function addTo(route: WebSocketRoute): () => void {
  return () => {
    createApp().ws('/chat', route)
  }
}

describe('registering a WebSocket route', () => {
  it('refuses an idle time below 8 seconds or above 960 seconds, because uWebSockets.js aborts the process for one', () => {
    for (const idleTimeoutMs of [0, 7_999, 960_001, 1.5, -1, Number.NaN]) {
      expect(addTo({ idleTimeoutMs })).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    }
    for (const idleTimeoutMs of [8_000, 120_000, 960_000]) expect(addTo({ idleTimeoutMs })).not.toThrow()
  })

  it('refuses a lifetime above 239 minutes and accepts 0, which means no limit', () => {
    for (const maxLifetimeMs of [239 * 60_000 + 1, 240 * 60_000, -1, 2.5]) {
      expect(addTo({ maxLifetimeMs })).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    }
    for (const maxLifetimeMs of [0, 1, 239 * 60_000]) expect(addTo({ maxLifetimeMs })).not.toThrow()
  })

  it('refuses a backpressure limit of 0, which uWebSockets.js reads as no limit, and sizes beyond 32 bits', () => {
    for (const maxBackpressureBytes of [0, -1, 2 ** 31, 0.5]) {
      expect(addTo({ maxBackpressureBytes })).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    }
    for (const maxMessageBytes of [-1, 2 ** 31, 1.5]) {
      expect(addTo({ maxMessageBytes })).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    }
    expect(addTo({ maxBackpressureBytes: 1, maxMessageBytes: 0 })).not.toThrow()
  })

  it('refuses a flag that is not true or false, and a handler that is not a function', () => {
    for (const route of [
      { compression: 'yes' },
      { closeOnBackpressureLimit: 1 },
      { open: 'hello' },
      { message: {} },
      { drain: 1 },
      { close: null },
    ]) {
      expect(addRoute(route)).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    }
  })

  it('refuses the null origin, a wildcard, and any origin with a path, credentials, or another scheme', () => {
    for (const origin of [
      'null',
      '*',
      'https://app.example.com/',
      'https://app.example.com/chat',
      'https://user:pass@app.example.com',
      'ftp://app.example.com',
      'app.example.com',
      '',
    ]) {
      expect(addRoute({ origins: [origin] })).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    }
    expect(addRoute({ origins: 'https://app.example.com' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ROUTE' }),
    )
    expect(addTo({ origins: ['https://app.example.com', 'http://localhost:5173'] })).not.toThrow()
  })

  it('refuses body and maxBodyBytes in the options of a WebSocket route', () => {
    expect(addRoute({}, { body: true })).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    expect(addRoute({}, { maxBodyBytes: 10 })).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    expect(addRoute({}, { headers: ['authorization'], timeoutMs: 100 })).not.toThrow()
  })

  it('refuses a missing route object and a middleware in its place', () => {
    expect(addRoute(undefined)).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    expect(addRoute({ handle: () => undefined })).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    expect(addRoute(() => undefined)).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
  })

  it('refuses a second WebSocket route of the same shape, and accepts a GET route on the same path', () => {
    const app = createApp().ws('/rooms/:id', {})

    expect(() => app.ws('/rooms/:name', {})).toThrowError(expect.objectContaining({ code: 'INVALID_ROUTE' }))
    expect(() => app.get('/rooms/:id', c => c.text('room'))).not.toThrow()
  })
})

describe('the pub/sub options of an app', () => {
  it('refuses a pub/sub adapter that lacks one of its five methods', () => {
    const complete = {
      start: () => undefined,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
      publish: () => undefined,
      close: () => undefined,
    }
    for (const method of Object.keys(complete)) {
      const pubsub = { ...complete, [method]: 'missing' }
      expect(() => Reflect.apply(createApp, undefined, [{ pubsub }])).toThrowError(
        expect.objectContaining({ code: 'INVALID_APP_OPTIONS' }),
      )
    }
    for (const pubsub of [null, 'redis', 1]) {
      expect(() => Reflect.apply(createApp, undefined, [{ pubsub }])).toThrowError(
        expect.objectContaining({ code: 'INVALID_APP_OPTIONS' }),
      )
    }
    expect(() => createApp({ pubsub: complete })).not.toThrow()
  })

  it('publishes nothing and throws nothing for a publish before the app serves', () => {
    const app = createApp().ws('/chat', {})

    expect(() => app.publish('room', 'nobody listens yet')).not.toThrow()
  })
})

describe('a request without an upgrade to a WebSocket route', () => {
  it('receives a 426 that names the WebSocket protocol, after the middleware of the route', async () => {
    const seen: string[] = []
    const app = createApp()
      .use(async (c, next) => {
        await next()
        seen.push(`app ${c.reply?.status}`)
      })
      .ws('/chat', {})

    const response = await app.request('/chat')

    expect(response.status).toBe(426)
    expect(response.headers.get('upgrade')).toBe('websocket')
    expect(response.headers.get('sec-websocket-version')).toBe('13')
    expect(await response.json()).toEqual({
      error: { code: 'UPGRADE_REQUIRED', message: 'This path accepts WebSocket upgrade requests alone.' },
    })
    expect(seen).toEqual(['app 426'])
  })

  it('receives the headers of the 426 without a body for HEAD, and the methods of the path for OPTIONS', async () => {
    const app = createApp().ws('/chat', {})

    const head = await app.request('/chat', { method: 'HEAD' })
    const options = await app.request('/chat', { method: 'OPTIONS' })
    const post = await app.request('/chat', { method: 'POST' })

    expect(head.status).toBe(426)
    expect(await head.text()).toBe('')
    expect(options.status).toBe(204)
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    expect(post.status).toBe(405)
  })

  it('reaches the GET route that you added to the same path', async () => {
    const app = createApp()
      .get('/chat', c => c.text('the chat page'))
      .ws('/chat', {})

    const response = await app.request('/chat')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('the chat page')
  })
})
