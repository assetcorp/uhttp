import { describe, expect, it } from 'vitest'
import { createApp, UhttpError } from '../../index.js'
import { memoryLogger } from '../helpers/server.js'

describe('reply helpers', () => {
  it('sends text with a status and headers', async () => {
    const app = createApp().get('/hello', c => c.text('Hello', 201, { 'X-Greeting': 'yes' }))

    const response = await app.request('/hello')

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=UTF-8')
    expect(response.headers.get('x-greeting')).toBe('yes')
    expect(response.headers.get('content-length')).toBe('5')
    expect(await response.text()).toBe('Hello')
  })

  it('sends JSON with a content type that the headers replace', async () => {
    const app = createApp().get('/problem', c =>
      c.json({ title: 'Out of stock' }, 409, { 'content-type': 'application/problem+json' }),
    )

    const response = await app.request('/problem')

    expect(response.status).toBe(409)
    expect(response.headers.get('content-type')).toBe('application/problem+json')
    expect(await response.json()).toEqual({ title: 'Out of stock' })
  })

  it('sends bytes from a Uint8Array or an ArrayBuffer', async () => {
    const app = createApp()
      .get('/view', c => c.bytes(new Uint8Array([1, 2, 3])))
      .get('/buffer', c => c.bytes(new Uint8Array([4, 5]).buffer, 200, { 'content-type': 'image/png' }))

    const view = await app.request('/view')
    const buffer = await app.request('/buffer')

    expect(view.headers.get('content-type')).toBe('application/octet-stream')
    expect([...new Uint8Array(await view.arrayBuffer())]).toEqual([1, 2, 3])
    expect(buffer.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await buffer.arrayBuffer())]).toEqual([4, 5])
  })

  it('sends a redirect with a location and no body, as 302 by default', async () => {
    const app = createApp()
      .get('/old', c => c.redirect('/new'))
      .get('/moved', c => c.redirect('https://example.com/', 308))

    const found = await app.request('/old')
    const moved = await app.request('/moved')

    expect(found.status).toBe(302)
    expect(found.headers.get('location')).toBe('/new')
    expect(await found.text()).toBe('')
    expect(moved.status).toBe(308)
  })

  it('sends a redirect with the headers that the handler passes', async () => {
    const app = createApp().get('/old', c => c.redirect('/new', 301, { 'cache-control': 'max-age=3600' }))

    const response = await app.request('/old')

    expect(response.headers.get('location')).toBe('/new')
    expect(response.headers.get('cache-control')).toBe('max-age=3600')
  })

  it('throws INVALID_STATUS for a redirect status outside 301, 302, 303, 307, and 308', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger }).get('/old', c => c.redirect('/new', 200))

    expect((await app.request('/old')).status).toBe(500)
    expect(entries.map(entry => entry.details.err)).toEqual([expect.objectContaining({ code: 'INVALID_STATUS' })])
  })

  it('sends set-cookie lines from an array', async () => {
    const app = createApp().get('/login', c => c.text('ok', 200, { 'set-cookie': ['a=1', 'b=2'] }))

    expect((await app.request('/login')).headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })
})

describe('response headers from the context', () => {
  it('keeps a header that middleware sets before next() on the reply of the handler', async () => {
    const app = createApp()
      .use(async (c, next) => {
        c.header('cache-control', 'no-store')
        await next()
        c.header('x-after', 'yes')
      })
      .get('/users', c => c.text('list'))

    const response = await app.request('/users')

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-after')).toBe('yes')
  })

  it('lets the headers of a reply replace a header that a middleware set before next()', async () => {
    const app = createApp()
      .use(async (c, next) => {
        c.header('cache-control', 'no-store')
        await next()
      })
      .get('/users', c => c.text('list', 200, { 'cache-control': 'max-age=60' }))

    expect((await app.request('/users')).headers.get('cache-control')).toBe('max-age=60')
  })

  it('drops the headers of a reply that a later error reply replaces', async () => {
    const app = createApp()
      .use(async (_c, next) => {
        await next()
        throw new Error('the audit log is down')
      })
      .get('/account', c =>
        c.redirect('/login', 302, { 'set-cookie': 'session=abc', 'cache-control': 'public, max-age=3600' }),
      )

    const response = await app.request('/account')

    expect(response.status).toBe(500)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('cache-control')).toBeNull()
  })

  it('keeps a header that middleware set before next() when an error reply replaces the reply that replaced it', async () => {
    const app = createApp()
      .use(async (c, next) => {
        c.header('cache-control', 'no-store')
        await next()
        throw new Error('the audit log is down')
      })
      .get('/users', c => c.text('list', 200, { 'cache-control': 'max-age=60' }))

    const response = await app.request('/users')

    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('appends a line after next() to the header of the reply', async () => {
    const app = createApp()
      .use(async (c, next) => {
        await next()
        c.header('vary', 'Origin', { append: true })
      })
      .get('/users', c => c.text('list', 200, { vary: 'Accept-Encoding' }))

    expect((await app.request('/users')).headers.get('vary')).toBe('Accept-Encoding, Origin')
  })

  it('appends a line when you ask for it', async () => {
    const app = createApp().get('/users', c => {
      c.header('vary', 'Origin')
      c.header('vary', 'Accept-Encoding', { append: true })
      return c.text('list')
    })

    expect((await app.request('/users')).headers.get('vary')).toBe('Origin, Accept-Encoding')
  })

  it('drops the framing headers that the package alone sets', async () => {
    const app = createApp().get('/users', c => {
      for (const name of ['content-length', 'transfer-encoding', 'connection', 'date']) c.header(name, 'forged')
      return c.text('list', 200, { 'Content-Length': '999' })
    })

    const response = await app.request('/users')

    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('transfer-encoding')).toBeNull()
    expect(response.headers.get('connection')).toBeNull()
    expect(response.headers.get('date')).toBeNull()
  })

  it('sends a 500 for a header value with a line break, a NUL, or another control character', async () => {
    for (const value of ['a\r\nset-cookie: admin=1', 'a\nb', 'a\u0000b', 'a\u0007b', 'a\u007fb']) {
      const app = createApp().get('/users', c => {
        c.header('x-name', value)
        return c.text('list')
      })
      const response = await app.request('/users')
      expect(response.status, JSON.stringify(value)).toBe(500)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
  })

  it('sends a header value that contains a tab', async () => {
    const app = createApp().get('/users', c => c.text('list', 200, { 'x-tabbed': 'a\tb' }))

    expect((await app.request('/users')).headers.get('x-tabbed')).toBe('a\tb')
  })

  it('sends a 500 for a header name that is not an HTTP token', async () => {
    for (const name of ['', 'x name', 'x:y', 'café', 'x\r\ny']) {
      const app = createApp().get('/users', c => c.text('list', 200, { [name]: 'v' }))
      expect((await app.request('/users')).status, JSON.stringify(name)).toBe(500)
    }
  })

  it('throws INVALID_HEADER synchronously from c.header()', async () => {
    let thrown: unknown
    const app = createApp().get('/users', c => {
      try {
        c.header('bad name', 'v')
      } catch (error) {
        thrown = error
      }
      return c.text('list')
    })

    await app.request('/users')

    expect(thrown).toBeInstanceOf(UhttpError)
    expect(thrown).toMatchObject({ code: 'INVALID_HEADER', status: 500 })
  })
})
