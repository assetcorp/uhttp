import { describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'
import { type CsrfOptions, csrf } from '../../../middleware/csrf/index.js'
import { trustedProxies } from '../../../middleware/trusted-proxies/index.js'
import type { TestHeaders } from '../../../testing/index.js'
import { errorCodeOf } from '../../helpers/body.js'

const FORM = 'application/x-www-form-urlencoded'

function csrfApp(options?: CsrfOptions) {
  return createApp()
    .use(trustedProxies({ trust: ['10.0.0.5'] }))
    .use(csrf(options))
    .post('/transfer', c => c.text('done'))
    .get('/transfer', c => c.text('form'))
    .put('/transfer', c => c.text('put'))
    .delete('/transfer', c => c.text('deleted'))
    .patch('/transfer', c => c.text('patched'))
}

async function statusOf(
  app: ReturnType<typeof csrfApp>,
  headers: TestHeaders,
  method = 'POST',
  clientAddress?: string,
) {
  const response = await app.request('/transfer', {
    method,
    headers,
    body: 'amount=100',
    ...(clientAddress === undefined ? {} : { clientAddress }),
  })
  return { status: response.status, code: response.status === 403 ? await errorCodeOf(response) : undefined }
}

describe('csrf() with Sec-Fetch-Site', () => {
  it.each(['same-origin', 'none'])('allows %s', async site => {
    const result = await statusOf(csrfApp(), { 'content-type': FORM, 'sec-fetch-site': site })
    expect(result.status).toBe(200)
  })

  it.each(['cross-site', 'same-site', 'bogus'])('refuses %s with 403 CSRF_REJECTED', async site => {
    const result = await statusOf(csrfApp(), { 'content-type': FORM, 'sec-fetch-site': site })
    expect(result).toEqual({ status: 403, code: 'CSRF_REJECTED' })
  })

  it('rejects a cross-site request even when Origin matches the host', async () => {
    const result = await statusOf(csrfApp(), {
      'content-type': FORM,
      'sec-fetch-site': 'cross-site',
      origin: 'http://localhost',
    })
    expect(result.status).toBe(403)
  })

  it('allows a cross-site request from an origin that you named', async () => {
    const app = csrfApp({ origin: ['https://pay.example'] })
    const result = await statusOf(app, {
      'content-type': FORM,
      'sec-fetch-site': 'cross-site',
      origin: 'https://pay.example',
    })
    expect(result.status).toBe(200)
  })
})

describe('csrf() with Origin alone', () => {
  it('allows the origin of the request itself by default', async () => {
    const result = await statusOf(csrfApp(), { 'content-type': FORM, origin: 'http://localhost', host: 'localhost' })
    expect(result.status).toBe(200)
  })

  it('allows the own origin with a port', async () => {
    const result = await statusOf(csrfApp(), {
      'content-type': FORM,
      origin: 'http://localhost:8080',
      host: 'localhost:8080',
    })
    expect(result.status).toBe(200)
  })

  it('matches a default port in Host against an origin without one', async () => {
    const result = await statusOf(csrfApp(), {
      'content-type': FORM,
      origin: 'http://shop.example',
      host: 'shop.example:80',
    })
    expect(result.status).toBe(200)
  })

  it('uses the protocol and host that a trusted proxy reports', async () => {
    const result = await statusOf(
      csrfApp(),
      {
        'content-type': FORM,
        origin: 'https://shop.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'shop.example',
      },
      'POST',
      '10.0.0.5',
    )
    expect(result.status).toBe(200)
  })

  it.each([
    'https://evil.example',
    'http://localhost.evil.example',
    'https://localhost',
    'null',
    'http://localhost:81',
  ])('refuses the origin %j', async origin => {
    const result = await statusOf(csrfApp(), { 'content-type': FORM, origin, host: 'localhost' })
    expect(result).toEqual({ status: 403, code: 'CSRF_REJECTED' })
  })

  it('compares against the origins that you named in place of the own origin', async () => {
    const app = csrfApp({ origin: 'https://shop.example' })
    const named = await statusOf(app, { 'content-type': FORM, origin: 'https://shop.example' })
    const own = await statusOf(app, { 'content-type': FORM, origin: 'http://localhost' })
    expect(named.status).toBe(200)
    expect(own.status).toBe(403)
  })

  it('asks a function about the origin', async () => {
    const app = csrfApp({ origin: async origin => origin.endsWith('.shop.example') })
    const allowed = await statusOf(app, { 'content-type': FORM, origin: 'https://eu.shop.example' })
    const refused = await statusOf(app, { 'content-type': FORM, origin: 'https://evil.example' })
    expect(allowed.status).toBe(200)
    expect(refused.status).toBe(403)
  })

  it('rejects a request with neither header', async () => {
    const result = await statusOf(csrfApp(), { 'content-type': FORM })
    expect(result).toEqual({ status: 403, code: 'CSRF_REJECTED' })
  })
})

describe('csrf() scope', () => {
  it.each([
    ['form-urlencoded', FORM],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['text/plain', 'text/plain;charset=UTF-8'],
    ['uppercase form type', 'Application/X-WWW-Form-Urlencoded'],
    ['a malformed type', 'text/plain; ;;='],
  ])('checks %s', async (_name, contentType) => {
    const result = await statusOf(csrfApp(), { 'content-type': contentType, 'sec-fetch-site': 'cross-site' })
    expect(result.status).toBe(403)
  })

  it('treats a missing content type as text/plain', async () => {
    const response = await csrfApp().request('/transfer', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: 'x',
    })
    expect(response.status).toBe(403)
  })

  it('passes a JSON request on to the route, because a form cannot send JSON', async () => {
    const result = await statusOf(csrfApp(), { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })
    expect(result.status).toBe(200)
  })

  it.each(['PUT', 'DELETE', 'PATCH'])('checks %s', async method => {
    const result = await statusOf(csrfApp(), { 'content-type': FORM, 'sec-fetch-site': 'cross-site' }, method)
    expect(result.status).toBe(403)
  })

  it.each(['GET', 'HEAD', 'OPTIONS'])('leaves alone the safe method %s', async method => {
    const response = await csrfApp().request('/transfer', {
      method,
      headers: { 'content-type': FORM, 'sec-fetch-site': 'cross-site' },
    })
    expect(response.status).not.toBe(403)
  })

  it('runs no handler for a refused request', async () => {
    let handled = false
    const app = createApp()
      .use(csrf())
      .post('/transfer', c => {
        handled = true
        return c.text('done')
      })
    const response = await app.request('/transfer', {
      method: 'POST',
      headers: { 'content-type': FORM, 'sec-fetch-site': 'cross-site' },
      body: 'amount=100',
    })
    expect(response.status).toBe(403)
    expect(handled).toBe(false)
  })
})

describe('csrf() options', () => {
  it.each([
    ['the wildcard', { origin: '*' }],
    ['null', { origin: 'null' }],
    ['null in a list', { origin: ['https://shop.example', 'null'] }],
    ['an origin with a path', { origin: 'https://shop.example/app' }],
    ['a number', { origin: 7 }],
    ['an options value that is no object', 'https://shop.example'],
  ])('throws INVALID_MIDDLEWARE_OPTIONS for %s', (_name, options) => {
    const build = () => csrf(options as unknown as CsrfOptions)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })
})
