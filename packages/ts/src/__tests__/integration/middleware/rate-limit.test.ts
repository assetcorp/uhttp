import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../index.js'
import {
  type RateLimitHit,
  type RateLimitOptions,
  type RateLimitStore,
  rateLimit,
} from '../../../middleware/rate-limit/index.js'
import { trustedProxies } from '../../../middleware/trusted-proxies/index.js'
import { errorCodeOf } from '../../helpers/body.js'
import { memoryLogger } from '../../helpers/server.js'

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0)

afterEach(() => {
  vi.useRealTimers()
})

function limitedApp(options: RateLimitOptions) {
  return createApp()
    .use(trustedProxies({ trust: ['10.0.0.5'] }))
    .use(rateLimit(options))
    .get('/', c => c.text('ok'))
}

async function hit(app: ReturnType<typeof limitedApp>, clientAddress = '192.0.2.4', headers = {}) {
  return app.request('/', { clientAddress, headers })
}

describe('rateLimit() counting', () => {
  it('serves requests up to the limit and rejects the next one with 429 RATE_LIMITED', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const app = limitedApp({ limit: 3, windowMs: 60000 })
    const statuses: number[] = []
    for (let index = 0; index < 3; index++) statuses.push((await hit(app)).status)
    const refused = await hit(app)
    expect(statuses).toEqual([200, 200, 200])
    expect(refused.status).toBe(429)
    expect(await errorCodeOf(refused)).toBe('RATE_LIMITED')
    expect(refused.headers.get('retry-after')).toBe('60')
  })

  it('sends the IETF headers on every response', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const app = limitedApp({ limit: 3, windowMs: 60000 })
    const first = await hit(app)
    vi.setSystemTime(NOW + 15000)
    const second = await hit(app)
    expect(first.headers.get('ratelimit-policy')).toBe('"default";q=3;w=60')
    expect(first.headers.get('ratelimit')).toBe('"default";r=2;t=60')
    expect(second.headers.get('ratelimit')).toBe('"default";r=1;t=45')
    expect(first.headers.has('x-ratelimit-limit')).toBe(false)
  })

  it('sends zero remaining on a refused request', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const app = limitedApp({ limit: 1, windowMs: 10000 })
    await hit(app)
    const refused = await hit(app)
    expect(refused.headers.get('ratelimit')).toBe('"default";r=0;t=10')
  })

  it('adds the legacy headers when you ask for them', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const app = limitedApp({ limit: 5, windowMs: 60000, legacyHeaders: true })
    const response = await hit(app)
    expect(response.headers.get('x-ratelimit-limit')).toBe('5')
    expect(response.headers.get('x-ratelimit-remaining')).toBe('4')
    expect(response.headers.get('x-ratelimit-reset')).toBe(String((NOW + 60000) / 1000))
  })

  it('starts a new window once the old one ends', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const app = limitedApp({ limit: 1, windowMs: 1000 })
    expect((await hit(app)).status).toBe(200)
    expect((await hit(app)).status).toBe(429)
    vi.setSystemTime(NOW + 1000)
    expect((await hit(app)).status).toBe(200)
  })

  it('serves up to twice the limit across a window boundary', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const app = limitedApp({ limit: 2, windowMs: 1000 })
    await hit(app)
    vi.setSystemTime(NOW + 999)
    expect((await hit(app)).status).toBe(200)
    vi.setSystemTime(NOW + 1000)
    expect((await hit(app)).status).toBe(200)
    expect((await hit(app)).status).toBe(200)
    expect((await hit(app)).status).toBe(429)
  })

  it('runs no handler for a refused request', async () => {
    let handled = 0
    const app = createApp()
      .use(rateLimit({ limit: 1, windowMs: 60000 }))
      .get('/', c => {
        handled++
        return c.text('ok')
      })
    await app.request('/')
    await app.request('/')
    expect(handled).toBe(1)
  })
})

describe('rateLimit() keys', () => {
  it('counts each client address on its own', async () => {
    const app = limitedApp({ limit: 1, windowMs: 60000 })
    expect((await hit(app, '192.0.2.4')).status).toBe(200)
    expect((await hit(app, '192.0.2.5')).status).toBe(200)
    expect((await hit(app, '192.0.2.4')).status).toBe(429)
  })

  it('counts an IPv4-mapped address with its IPv4 form', async () => {
    const app = limitedApp({ limit: 1, windowMs: 60000 })
    await hit(app, '192.0.2.4')
    expect((await hit(app, '::ffff:192.0.2.4')).status).toBe(429)
  })

  it('groups IPv6 clients by /64', async () => {
    const app = limitedApp({ limit: 1, windowMs: 60000 })
    await hit(app, '2001:db8:1:2::1')
    expect((await hit(app, '2001:db8:1:2:ffff:ffff:ffff:ffff')).status).toBe(429)
    expect((await hit(app, '2001:db8:1:3::1')).status).toBe(200)
  })

  it('keys on the client behind a trusted proxy', async () => {
    const app = limitedApp({ limit: 1, windowMs: 60000 })
    await hit(app, '10.0.0.5', { 'x-forwarded-for': '203.0.113.1' })
    expect((await hit(app, '10.0.0.5', { 'x-forwarded-for': '203.0.113.2' })).status).toBe(200)
    expect((await hit(app, '10.0.0.5', { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429)
  })

  it('counts by the key that your async key function returns', async () => {
    const app = createApp()
      .use(rateLimit({ limit: 1, windowMs: 60000, key: async c => c.req.query }))
      .get('/', c => c.text('ok'))
    expect((await app.request('/?user=ada')).status).toBe(200)
    expect((await app.request('/?user=alan')).status).toBe(200)
    expect((await app.request('/?user=ada')).status).toBe(429)
  })

  it('declares the headers that you list, so that your key function can get their values', async () => {
    const app = createApp()
      .use(rateLimit({ limit: 1, windowMs: 60000, headers: ['X-Api-Key'], key: c => c.req.header('x-api-key') ?? '' }))
      .get('/', c => c.text('ok'))
    const key = (value: string) => app.request('/', { headers: { 'x-api-key': value } })
    expect((await key('shoes')).status).toBe(200)
    expect((await key('hats')).status).toBe(200)
    expect((await key('shoes')).status).toBe(429)
  })

  it('replies 500 when your key function asks for a header that you never declared', async () => {
    const app = createApp()
      .use(rateLimit({ limit: 1, windowMs: 60000, key: c => c.req.header('x-api-key') ?? '' }))
      .get('/', c => c.text('ok'))
    expect((await app.request('/', { headers: { 'x-api-key': 'shoes' } })).status).toBe(500)
  })

  it('keeps long keys apart', async () => {
    const app = createApp()
      .use(rateLimit({ limit: 1, windowMs: 60000, key: c => `${'k'.repeat(100)}${c.req.query}` }))
      .get('/', c => c.text('ok'))
    expect((await app.request('/?n=1')).status).toBe(200)
    expect((await app.request('/?n=2')).status).toBe(200)
    expect((await app.request('/?n=1')).status).toBe(429)
  })

  it('keeps separate counts for two limiters', async () => {
    const app = createApp()
    app.group('/a', rateLimit({ limit: 1, windowMs: 60000 })).get('/', c => c.text('a'))
    app.group('/b', rateLimit({ limit: 1, windowMs: 60000 })).get('/', c => c.text('b'))
    expect((await app.request('/a')).status).toBe(200)
    expect((await app.request('/b')).status).toBe(200)
    expect((await app.request('/a')).status).toBe(429)
  })
})

describe('rateLimit() store', () => {
  it('counts through your store', async () => {
    const calls: [string, number][] = []
    const store: RateLimitStore = {
      async increment(key, windowMs): Promise<RateLimitHit> {
        calls.push([key, windowMs])
        return { count: calls.length, resetAt: Date.now() + windowMs }
      },
    }
    const app = limitedApp({ limit: 1, windowMs: 5000, store })
    expect((await hit(app)).status).toBe(200)
    expect((await hit(app)).status).toBe(429)
    expect(calls).toEqual([
      ['192.0.2.4', 5000],
      ['192.0.2.4', 5000],
    ])
  })

  it('replies 500 when the promise of your store rejects', async () => {
    const store: RateLimitStore = {
      increment: () => Promise.reject(new Error('redis down')),
    }
    expect((await hit(limitedApp({ limit: 1, windowMs: 5000, store }))).status).toBe(500)
  })

  it('serves requests with new keys and warns once when the built-in store is full', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger })
      .use(rateLimit({ limit: 1, windowMs: 60000, maxKeys: 2 }))
      .get('/', c => c.text('ok'))
    for (const address of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.3']) {
      expect((await app.request('/', { clientAddress: address })).status).toBe(200)
    }
    expect((await app.request('/', { clientAddress: '192.0.2.1' })).status).toBe(429)
    expect(entries.filter(entry => entry.level === 'warn')).toHaveLength(1)
  })

  it('frees expired keys on its timer', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval'] })
    const app = createApp()
      .use(rateLimit({ limit: 1, windowMs: 1000, maxKeys: 1 }))
      .get('/', c => c.text('ok'))
    await app.request('/', { clientAddress: '192.0.2.1' })
    vi.advanceTimersByTime(1000)
    await app.request('/', { clientAddress: '192.0.2.2' })
    expect((await app.request('/', { clientAddress: '192.0.2.2' })).status).toBe(429)
  })

  it('keeps counting correctly after thousands of keys expire and return', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval'] })
    const app = createApp()
      .use(rateLimit({ limit: 1, windowMs: 1000, maxKeys: 4096 }))
      .get('/', c => c.text('ok'))
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index < 4000; index++) {
        const address = `10.${round}.${index >> 8}.${index & 255}`
        expect((await app.request('/', { clientAddress: address })).status).toBe(200)
      }
      expect((await app.request('/', { clientAddress: `10.${round}.0.7` })).status).toBe(429)
      vi.advanceTimersByTime(1000)
    }
  })
})

describe('rateLimit() options', () => {
  it.each([
    ['no limit', { windowMs: 1000 }],
    ['a zero limit', { limit: 0, windowMs: 1000 }],
    ['a fractional limit', { limit: 1.5, windowMs: 1000 }],
    ['no window', { limit: 1 }],
    ['a window under one second', { limit: 1, windowMs: 999 }],
    ['a window past the timer limit', { limit: 1, windowMs: 2 ** 31 }],
    ['a key that is no function', { limit: 1, windowMs: 1000, key: 'ip' }],
    ['a store without increment', { limit: 1, windowMs: 1000, store: {} }],
    ['maxKeys of zero', { limit: 1, windowMs: 1000, maxKeys: 0 }],
    ['maxKeys past the cap', { limit: 1, windowMs: 1000, maxKeys: 2 ** 21 }],
    [
      'maxKeys next to a store',
      { limit: 1, windowMs: 1000, maxKeys: 10, store: { increment: () => ({ count: 1, resetAt: 0 }) } },
    ],
    ['legacyHeaders that is no boolean', { limit: 1, windowMs: 1000, legacyHeaders: 'yes' }],
    ['headers that is no list', { limit: 1, windowMs: 1000, headers: 'x-api-key' }],
    ['a header name with a space', { limit: 1, windowMs: 1000, headers: ['x api key'] }],
    ['an empty header name', { limit: 1, windowMs: 1000, headers: [''] }],
  ])('throws INVALID_MIDDLEWARE_OPTIONS for %s', (_name, options) => {
    const build = () => rateLimit(options as unknown as RateLimitOptions)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })
})
