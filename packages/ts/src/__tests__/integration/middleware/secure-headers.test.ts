import { describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'
import { nonceOf, type SecureHeadersOptions, secureHeaders } from '../../../middleware/secure-headers/index.js'
import { trustedProxies } from '../../../middleware/trusted-proxies/index.js'

const WEB_HEADERS = {
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
}

const API_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

const HSTS = 'max-age=15552000; includeSubDomains'

const BASE_HEADERS = new Set(['content-type', 'content-length'])

function securityHeadersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (!BASE_HEADERS.has(name)) headers[name] = value
  })
  return headers
}

function headerApp(options?: SecureHeadersOptions) {
  return createApp()
    .use(trustedProxies({ trust: ['10.0.0.5'] }))
    .use(secureHeaders(options))
    .get('/', c => c.text('home'))
}

describe('secureHeaders() presets', () => {
  it('sends the web preset by default, without HSTS on plain HTTP', async () => {
    const response = await headerApp().request('/')
    expect(securityHeadersOf(response)).toEqual(WEB_HEADERS)
  })

  it('sends the api preset', async () => {
    const response = await headerApp({ preset: 'api' }).request('/')
    expect(securityHeadersOf(response)).toEqual(API_HEADERS)
  })

  it('sends HSTS when a trusted proxy reports https', async () => {
    const response = await headerApp().request('/', {
      clientAddress: '10.0.0.5',
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(securityHeadersOf(response)).toEqual({ ...WEB_HEADERS, 'strict-transport-security': HSTS })
  })

  it('leaves out HSTS when an untrusted peer reports https', async () => {
    const response = await headerApp().request('/', {
      clientAddress: '192.0.2.4',
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(response.headers.has('strict-transport-security')).toBe(false)
  })

  it('sends the headers on a 404 and on an error reply', async () => {
    const app = createApp()
      .use(secureHeaders())
      .get('/broken', () => {
        throw new Error('broken')
      })
    const missing = await app.request('/missing')
    const broken = await app.request('/broken')
    expect(missing.status).toBe(404)
    expect(broken.status).toBe(500)
    expect(missing.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(broken.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })
})

describe('secureHeaders() changes', () => {
  it('changes, switches off, and adds headers', async () => {
    const response = await headerApp({
      headers: {
        'X-Frame-Options': 'DENY',
        'x-xss-protection': false,
        'Permissions-Policy': 'camera=()',
      },
    }).request('/')
    const { 'x-xss-protection': _dropped, ...kept } = WEB_HEADERS
    expect(securityHeadersOf(response)).toEqual({
      ...kept,
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=()',
    })
  })

  it('changes and switches off HSTS', async () => {
    const https = { clientAddress: '10.0.0.5', headers: { 'x-forwarded-proto': 'https' } }
    const changed = await headerApp({ headers: { 'strict-transport-security': 'max-age=63072000; preload' } }).request(
      '/',
      https,
    )
    const off = await headerApp({ headers: { 'strict-transport-security': false } }).request('/', https)
    expect(changed.headers.get('strict-transport-security')).toBe('max-age=63072000; preload')
    expect(off.headers.has('strict-transport-security')).toBe(false)
  })

  it('keeps the value of a header that the handler set', async () => {
    const app = createApp()
      .use(secureHeaders())
      .get('/frame', c => c.text('framed', 200, { 'x-frame-options': 'ALLOW-FROM https://shop.example' }))
      .get('/context', c => {
        c.header('Referrer-Policy', 'strict-origin')
        return c.text('context')
      })
    const framed = await app.request('/frame')
    const context = await app.request('/context')
    expect(framed.headers.get('x-frame-options')).toBe('ALLOW-FROM https://shop.example')
    expect(context.headers.get('referrer-policy')).toBe('strict-origin')
  })
})

describe('secureHeaders() nonce', () => {
  it('sends a CSP with a new nonce on each request, and nonceOf returns the nonce of that policy', async () => {
    const app = createApp()
      .use(secureHeaders({ contentSecurityPolicy: nonce => `script-src 'nonce-${nonce}'` }))
      .get('/', c => c.text(nonceOf(c) ?? 'none'))

    const first = await app.request('/')
    const second = await app.request('/')
    const firstNonce = await first.text()
    const secondNonce = await second.text()

    expect(firstNonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(firstNonce).not.toBe(secondNonce)
    expect(first.headers.get('content-security-policy')).toBe(`script-src 'nonce-${firstNonce}'`)
    expect(second.headers.get('content-security-policy')).toBe(`script-src 'nonce-${secondNonce}'`)
  })

  it('returns undefined from nonceOf without a nonce policy', async () => {
    const app = createApp()
      .use(secureHeaders())
      .get('/', c => c.text(String(nonceOf(c))))
    expect(await (await app.request('/')).text()).toBe('undefined')
  })

  it('replies 500 when the policy function returns a value with a line break', async () => {
    const app = createApp()
      .use(secureHeaders({ contentSecurityPolicy: () => "default-src 'self'\r\nset-cookie: a=b" }))
      .get('/', c => c.text('home'))
    const response = await app.request('/')
    expect(response.status).toBe(500)
    expect(response.headers.has('set-cookie')).toBe(false)
  })
})

describe('secureHeaders() options', () => {
  it.each([
    ['an unknown preset', { preset: 'strict' }],
    ['a header value that is a number', { headers: { 'x-frame-options': 1 } }],
    ['a header value with a line break', { headers: { 'x-frame-options': 'DENY\r\nx: y' } }],
    ['a header name with a space', { headers: { 'x frame': 'DENY' } }],
    ['a framing header', { headers: { 'content-length': '0' } }],
    ['a policy that is no function', { contentSecurityPolicy: "default-src 'self'" }],
    [
      'a policy function next to a fixed policy',
      {
        contentSecurityPolicy: () => "default-src 'self'",
        headers: { 'content-security-policy': "default-src 'none'" },
      },
    ],
  ])('throws INVALID_MIDDLEWARE_OPTIONS for %s', (_name, options) => {
    const build = () => secureHeaders(options as unknown as SecureHeadersOptions)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })
})
