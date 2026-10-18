import { describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'
import { requestId, requestIdOf } from '../../../middleware/request-id/index.js'
import { trustedProxies } from '../../../middleware/trusted-proxies/index.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function idApp() {
  return createApp()
    .use(trustedProxies({ trust: ['10.0.0.5'] }))
    .use(requestId())
    .get('/', c => c.text(requestIdOf(c) ?? 'none'))
}

describe('requestId()', () => {
  it('generates a UUID and returns it on the response', async () => {
    const response = await idApp().request('/')
    const id = await response.text()
    expect(id).toMatch(UUID)
    expect(response.headers.get('x-request-id')).toBe(id)
  })

  it('generates a different ID for each request', async () => {
    const app = idApp()
    const first = await app.request('/')
    const second = await app.request('/')
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'))
  })

  it('keeps a valid inbound ID from a trusted peer', async () => {
    const id = `trace_${'A1=-'.repeat(62)}`.slice(0, 255)
    const response = await idApp().request('/', { clientAddress: '10.0.0.5', headers: { 'x-request-id': id } })
    expect(await response.text()).toBe(id)
    expect(response.headers.get('x-request-id')).toBe(id)
  })

  it('replaces an inbound ID from an untrusted peer', async () => {
    const response = await idApp().request('/', { clientAddress: '192.0.2.4', headers: { 'x-request-id': 'abc' } })
    expect(await response.text()).toMatch(UUID)
  })

  it('replaces an inbound ID when trustedProxies() is absent', async () => {
    const app = createApp()
      .use(requestId())
      .get('/', c => c.text(requestIdOf(c) ?? 'none'))
    const response = await app.request('/', { headers: { 'x-request-id': 'abc' } })
    expect(await response.text()).toMatch(UUID)
  })

  it.each([
    ['256 characters', 'a'.repeat(256)],
    ['a space', 'abc def'],
    ['a dot', 'abc.def'],
    ['a slash', 'abc/def'],
    ['a non-ASCII letter', 'abcé'],
    ['a newline escape', 'abc%0d%0aset-cookie:x'],
  ])('replaces an inbound ID with %s from a trusted peer', async (_name, id) => {
    const response = await idApp().request('/', { clientAddress: '10.0.0.5', headers: { 'x-request-id': id } })
    const generated = await response.text()
    expect(generated).toMatch(UUID)
    expect(response.headers.get('x-request-id')).toBe(generated)
  })

  it('returns the ID on an error reply', async () => {
    const app = createApp()
      .use(requestId())
      .get('/', () => {
        throw new Error('broken')
      })
    const response = await app.request('/')
    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toMatch(UUID)
  })

  it('returns the ID on a 404 from an app-level middleware', async () => {
    const response = await idApp().request('/missing')
    expect(response.status).toBe(404)
    expect(response.headers.get('x-request-id')).toMatch(UUID)
  })

  it('returns undefined from requestIdOf on a route without the middleware', async () => {
    const app = createApp().get('/', c => c.text(String(requestIdOf(c))))
    const response = await app.request('/')
    expect(await response.text()).toBe('undefined')
  })
})
