import { describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'
import { errorCodeOf } from '../../helpers/body.js'

function post(body: string | Uint8Array, contentType?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra }
  if (contentType !== undefined) headers['content-type'] = contentType
  return { method: 'POST', headers, body }
}

describe('json()', () => {
  const app = createApp().post('/json', async c => c.json({ received: await c.req.body.json() }))

  it('parses a JSON body with an application/json or a +json content type', async () => {
    const plain = await app.request('/json', post('{"name":"Ama"}', 'application/json'))
    const problem = await app.request('/json', post('[1,2]', 'application/problem+json; charset=utf-8'))

    expect(await plain.json()).toEqual({ received: { name: 'Ama' } })
    expect(await problem.json()).toEqual({ received: [1, 2] })
  })

  it('answers 415 with UNSUPPORTED_MEDIA_TYPE for another content type or none', async () => {
    const wrong = await app.request('/json', post('{}', 'text/plain'))
    const missing = await app.request('/json', post('{}'))
    const charset = await app.request('/json', post('{}', 'application/json; charset=latin1'))

    for (const response of [wrong, missing, charset]) {
      expect(response.status).toBe(415)
      expect(await errorCodeOf(response)).toBe('UNSUPPORTED_MEDIA_TYPE')
    }
  })

  it('answers 400 with INVALID_JSON when the body fails to parse', async () => {
    const broken = await app.request('/json', post('{"name":', 'application/json'))
    const empty = await app.request('/json', post('', 'application/json'))

    expect(broken.status).toBe(400)
    expect(await errorCodeOf(broken)).toBe('INVALID_JSON')
    expect(await errorCodeOf(empty)).toBe('INVALID_JSON')
  })

  it('refuses a __proto__ key at any depth, including one written with escapes', async () => {
    const bodies = [
      '{"__proto__":{"admin":true}}',
      '{"user":{"__proto__":{"admin":true}}}',
      '[{"\\u005f_proto__":{"admin":true}}]',
    ]

    for (const body of bodies) {
      const response = await app.request('/json', post(body, 'application/json'))
      expect(response.status).toBe(400)
      expect(await errorCodeOf(response)).toBe('INVALID_JSON')
    }
  })

  it('refuses a constructor key whose value has a prototype key', async () => {
    const poisoned = await app.request('/json', post('{"a":{"constructor":{"prototype":{"x":1}}}}', 'application/json'))

    expect(poisoned.status).toBe(400)
    expect(await errorCodeOf(poisoned)).toBe('INVALID_JSON')
  })

  it('accepts the text __proto__ inside a string value', async () => {
    const response = await app.request('/json', post('{"note":"\\"__proto__\\": is a key"}', 'application/json'))

    expect(await response.json()).toEqual({ received: { note: '"__proto__": is a key' } })
  })
})

describe('text() and bytes()', () => {
  it('decodes a text body with its charset', async () => {
    const app = createApp().post('/text', async c => c.text(await c.req.body.text()))

    const utf8 = await app.request('/text', post('Akwaaba ✓', 'text/plain; charset=utf-8'))
    const latin1 = await app.request(
      '/text',
      post(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'text/csv; charset=latin1'),
    )

    expect(await utf8.text()).toBe('Akwaaba ✓')
    expect(await latin1.text()).toBe('café')
  })

  it('answers 415 when text() meets a type outside text/* or an unknown charset', async () => {
    const app = createApp().post('/text', async c => c.text(await c.req.body.text()))

    const json = await app.request('/text', post('{}', 'application/json'))
    const unknown = await app.request('/text', post('abc', 'text/plain; charset=no-such-charset'))

    expect(json.status).toBe(415)
    expect(unknown.status).toBe(415)
  })

  it('returns the raw bytes whatever the content type', async () => {
    const app = createApp().post('/bytes', async c => c.json([...(await c.req.body.bytes())]))

    const response = await app.request('/bytes', post(new Uint8Array([0, 1, 255]), 'image/png'))

    expect(await response.json()).toEqual([0, 1, 255])
  })

  it('parses the same body again on a second read', async () => {
    const app = createApp().post('/twice', async c => {
      const text = await c.req.body.text()
      const bytes = await c.req.body.bytes()
      return c.json({ text, length: bytes.byteLength })
    })

    const response = await app.request('/twice', post('twice', 'text/plain'))

    expect(await response.json()).toEqual({ text: 'twice', length: 5 })
  })

  it('throws BODY_ALREADY_READ when code reads a body after streaming it', async () => {
    const codes: string[] = []
    const app = createApp({
      onError: (error, c) => {
        codes.push((error as { code: string }).code)
        return c.text('failed', 500)
      },
    }).post('/stream-then-text', async c => {
      for await (const _chunk of c.req.body.stream());
      return c.text(await c.req.body.text())
    })

    await app.request('/stream-then-text', post('abc', 'text/plain'))

    expect(codes).toEqual(['BODY_ALREADY_READ'])
  })
})

describe('the Content-Encoding check', () => {
  it('answers 415 with Accept-Encoding: identity and keeps the connection open for a compressed body', async () => {
    let handled = false
    const app = createApp().post('/upload', c => {
      handled = true
      return c.text('ok')
    })

    const response = await app.request('/upload', post('abc', 'text/plain', { 'content-encoding': 'gzip' }))

    expect(response.status).toBe(415)
    expect(await errorCodeOf(response)).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(response.headers.get('accept-encoding')).toBe('identity')
    expect(response.headers.get('connection')).toBeNull()
    expect(handled).toBe(false)
  })

  it('accepts a body whose Content-Encoding is identity', async () => {
    const app = createApp().post('/upload', async c => c.text(await c.req.body.text()))

    const response = await app.request('/upload', post('abc', 'text/plain', { 'content-encoding': 'Identity' }))

    expect(await response.text()).toBe('abc')
  })
})

describe('form()', () => {
  const app = createApp().post('/form', async c => c.json(await c.req.body.form()))
  const formType = 'application/x-www-form-urlencoded'

  it('parses a URL-encoded body into a flat map of names and values', async () => {
    const response = await app.request('/form', post('name=Ama+Mensah&city=Accra%20North&empty=', formType))

    expect(await response.json()).toEqual({ name: 'Ama Mensah', city: 'Accra North', empty: '' })
  })

  it('keeps brackets and dots in names, and collects a repeated name into a list', async () => {
    const response = await app.request('/form', post('user[name]=Ama&user.age=30&tag=a&tag=b&tag=c', formType))

    expect(await response.json()).toEqual({ 'user[name]': 'Ama', 'user.age': '30', tag: ['a', 'b', 'c'] })
  })

  it('stores __proto__ as an ordinary name', async () => {
    const probe = createApp().post('/form', async c => {
      const form = await c.req.body.form()
      return c.json({
        value: Object.getOwnPropertyDescriptor(form, '__proto__')?.value,
        polluted: Object.hasOwn(Object.prototype, 'admin'),
      })
    })

    const response = await probe.request('/form', post('__proto__=x&admin=true', formType))

    expect(await response.json()).toEqual({ value: 'x', polluted: false })
  })

  it('keeps a malformed percent sequence as text, as browsers do', async () => {
    const response = await app.request('/form', post('a=100%&b=%E0%A4%A', formType))

    expect(await response.json()).toEqual({ a: '100%', b: '�%A' })
  })

  it('answers 413 once the body passes 1,000 parameters', async () => {
    const fields = (count: number) => Array.from({ length: count }, (_, index) => `f${index}=1`).join('&')

    const within = await app.request('/form', post(fields(1000), formType))
    const beyond = await app.request('/form', post(fields(1001), formType))

    expect(within.status).toBe(200)
    expect(beyond.status).toBe(413)
    expect(await errorCodeOf(beyond)).toBe('PAYLOAD_TOO_LARGE')
  })

  it('answers 415 for another content type', async () => {
    const response = await app.request('/form', post('a=1', 'text/plain'))

    expect(response.status).toBe(415)
  })
})
