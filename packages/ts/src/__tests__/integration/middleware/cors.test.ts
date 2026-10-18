import { describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'
import { type CorsOptions, cors } from '../../../middleware/cors/index.js'

const SHOP = 'https://shop.example'
const ADMIN = 'https://admin.example'
const EVIL = 'https://evil.example'

function corsApp(options: CorsOptions) {
  return createApp()
    .use(cors(options))
    .get('/items', c => c.json(['tea']))
    .post('/items', c => c.json({ created: true }, 201))
}

function preflight(origin: string, method = 'PUT', requestHeaders?: string) {
  const headers: Record<string, string> = { origin, 'access-control-request-method': method }
  if (requestHeaders !== undefined) headers['access-control-request-headers'] = requestHeaders
  return { method: 'OPTIONS', headers }
}

function varyOf(response: Response): string[] {
  return (response.headers.get('vary') ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry !== '')
}

describe('cors() simple requests', () => {
  it('sends ACAO * without Vary for the wildcard', async () => {
    const response = await corsApp({ origin: '*' }).request('/items', { headers: { origin: EVIL } })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.has('vary')).toBe(false)
  })

  it('sends the single static origin to every request without Vary', async () => {
    const app = corsApp({ origin: SHOP })
    const matching = await app.request('/items', { headers: { origin: SHOP } })
    const other = await app.request('/items', { headers: { origin: EVIL } })
    const none = await app.request('/items')
    for (const response of [matching, other, none]) {
      expect(response.headers.get('access-control-allow-origin')).toBe(SHOP)
      expect(response.headers.has('vary')).toBe(false)
    }
  })

  it('echoes an allowed origin from a list with Vary: Origin', async () => {
    const response = await corsApp({ origin: [SHOP, ADMIN] }).request('/items', { headers: { origin: ADMIN } })
    expect(response.headers.get('access-control-allow-origin')).toBe(ADMIN)
    expect(varyOf(response)).toEqual(['origin'])
  })

  it('sends no CORS headers to a disallowed origin, but still sends Vary: Origin', async () => {
    const response = await corsApp({ origin: [SHOP] }).request('/items', { headers: { origin: EVIL } })
    expect(response.status).toBe(200)
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(response.headers.has('access-control-allow-credentials')).toBe(false)
    expect(varyOf(response)).toEqual(['origin'])
  })

  it('sends Vary: Origin to a request without Origin under a list', async () => {
    const response = await corsApp({ origin: [SHOP] }).request('/items')
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(varyOf(response)).toEqual(['origin'])
  })

  it.each([
    'https://shop.example/',
    'https://SHOP.example',
    'https://shop.example.evil.example',
    'https://evilshop.example',
    'http://shop.example',
  ])('refuses the near miss %j', async origin => {
    const response = await corsApp({ origin: [SHOP] }).request('/items', { headers: { origin } })
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
  })

  it('asks a function, which can be async, about each origin', async () => {
    const asked: string[] = []
    const app = corsApp({
      origin: async origin => {
        asked.push(origin)
        return origin.endsWith('.shop.example')
      },
    })
    const allowed = await app.request('/items', { headers: { origin: 'https://eu.shop.example' } })
    const refused = await app.request('/items', { headers: { origin: EVIL } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://eu.shop.example')
    expect(refused.headers.has('access-control-allow-origin')).toBe(false)
    expect(varyOf(allowed)).toEqual(['origin'])
    expect(asked).toEqual(['https://eu.shop.example', EVIL])
  })

  it('never passes a malformed origin to the function', async () => {
    const asked: string[] = []
    const app = corsApp({ origin: origin => asked.push(origin) > 0 })
    const response = await app.request('/items', { headers: { origin: 'https://shop.example/path' } })
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(asked).toEqual([])
  })

  it('sends credentials and exposed headers on an allowed request', async () => {
    const response = await corsApp({ origin: [SHOP], credentials: true, exposeHeaders: ['X-Total', 'ETag'] }).request(
      '/items',
      { headers: { origin: SHOP } },
    )
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('access-control-expose-headers')).toBe('X-Total, ETag')
  })

  it('keeps the CORS headers on an error reply', async () => {
    const app = createApp()
      .use(cors({ origin: [SHOP] }))
      .get('/broken', () => {
        throw new Error('broken')
      })
    const response = await app.request('/broken', { headers: { origin: SHOP } })
    expect(response.status).toBe(500)
    expect(response.headers.get('access-control-allow-origin')).toBe(SHOP)
  })

  it('appends Origin to a Vary header that the handler set', async () => {
    const app = createApp()
      .use(cors({ origin: [SHOP] }))
      .get('/items', c => c.json([], 200, { vary: 'Accept-Encoding' }))
    const response = await app.request('/items', { headers: { origin: SHOP } })
    expect(varyOf(response)).toEqual(['accept-encoding', 'origin'])
  })
})

describe('cors() preflight requests', () => {
  it('replies to a preflight with 204 and the configured values', async () => {
    const response = await corsApp({
      origin: [SHOP],
      methods: ['GET', 'PUT'],
      allowHeaders: ['Content-Type', 'X-Token'],
      credentials: true,
      maxAge: 120,
    }).request('/items', preflight(SHOP))
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get('access-control-allow-origin')).toBe(SHOP)
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, PUT')
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type, X-Token')
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('access-control-max-age')).toBe('120')
    expect(response.headers.has('access-control-expose-headers')).toBe(false)
    expect(varyOf(response)).toEqual(['origin'])
  })

  it('uses the default methods and a max age of 600', async () => {
    const response = await corsApp({ origin: SHOP }).request('/items', preflight(SHOP))
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD, PUT, POST, DELETE, PATCH')
    expect(response.headers.get('access-control-max-age')).toBe('600')
  })

  it('replies to a preflight on a path with no route', async () => {
    const response = await corsApp({ origin: SHOP }).request('/nowhere', preflight(SHOP))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(SHOP)
  })

  it('passes a preflight from a disallowed origin on to the routes', async () => {
    const response = await corsApp({ origin: [SHOP] }).request('/items', preflight(EVIL))
    expect(response.status).toBe(204)
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(response.headers.has('access-control-allow-methods')).toBe(false)
  })

  it('passes a preflight from another origin on to the routes under a single static origin', async () => {
    const app = corsApp({ origin: SHOP, credentials: true })
    const refused = await app.request('/items', preflight(EVIL))
    expect(refused.status).toBe(204)
    expect(refused.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
    for (const name of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-methods',
      'access-control-max-age',
    ]) {
      expect(refused.headers.has(name)).toBe(false)
    }
    const missing = await app.request('/nowhere', preflight(EVIL))
    expect(missing.status).toBe(404)
    expect(missing.headers.has('access-control-allow-origin')).toBe(false)
    const allowed = await app.request('/nowhere', preflight(SHOP))
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    expect(allowed.headers.has('vary')).toBe(false)
  })

  it('treats an OPTIONS request without Access-Control-Request-Method as a plain request', async () => {
    const response = await corsApp({ origin: [SHOP] }).request('/items', {
      method: 'OPTIONS',
      headers: { origin: SHOP },
    })
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
    expect(response.headers.get('access-control-allow-origin')).toBe(SHOP)
    expect(response.headers.has('access-control-allow-methods')).toBe(false)
  })

  it('echoes the requested headers when none are configured', async () => {
    const response = await corsApp({ origin: [SHOP] }).request(
      '/items',
      preflight(SHOP, 'POST', 'content-type, x-token'),
    )
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type, x-token')
    expect(varyOf(response)).toEqual(['origin', 'access-control-request-headers'])
  })

  it('echoes the requested headers across several header lines', async () => {
    const response = await corsApp({ origin: SHOP }).request('/items', {
      method: 'OPTIONS',
      headers: [
        ['origin', SHOP],
        ['access-control-request-method', 'POST'],
        ['access-control-request-headers', 'content-type'],
        ['access-control-request-headers', 'x-token'],
      ],
    })
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type, x-token')
  })

  it.each([
    ['a list past 1,024 characters', `${'x-a,'.repeat(300)}x-b`],
    ['a header name with a space', 'x token'],
    ['a header name with a slash', 'x/token'],
    ['an empty entry', 'x-a,,x-b'],
  ])('echoes nothing for %s', async (_name, requested) => {
    const response = await corsApp({ origin: SHOP }).request('/items', preflight(SHOP, 'POST', requested))
    expect(response.status).toBe(204)
    expect(response.headers.has('access-control-allow-headers')).toBe(false)
  })

  it('parses a hostile request-headers list in linear time', async () => {
    const hostile = `${' ,'.repeat(511)}`
    const started = performance.now()
    const response = await corsApp({ origin: SHOP }).request('/items', preflight(SHOP, 'POST', hostile))
    expect(performance.now() - started).toBeLessThan(500)
    expect(response.headers.has('access-control-allow-headers')).toBe(false)
  })
})

describe('cors() options', () => {
  it.each([
    ['no origin', {}],
    ['credentials with the wildcard', { origin: '*', credentials: true }],
    ['credentials with null', { origin: ['null', SHOP], credentials: true }],
    ['an origin with a path', { origin: 'https://shop.example/app' }],
    ['an origin with a trailing slash', { origin: ['https://shop.example/'] }],
    ['an origin with uppercase', { origin: 'https://Shop.example' }],
    ['an empty list', { origin: [] }],
    ['a number', { origin: 1 }],
    ['a negative max age', { origin: SHOP, maxAge: -1 }],
    ['a fractional max age', { origin: SHOP, maxAge: 1.5 }],
    ['a method that is no token', { origin: SHOP, methods: ['GE T'] }],
    ['a header that is no token', { origin: SHOP, allowHeaders: ['x token'] }],
  ])('throws INVALID_MIDDLEWARE_OPTIONS for %s', (_name, options) => {
    const build = () => cors(options as unknown as CorsOptions)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })
})
