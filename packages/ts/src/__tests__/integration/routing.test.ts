import { describe, expect, it } from 'vitest'
import { createApp, UhttpError } from '../../index.js'

const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: 'The app has no route for this path.' } }

describe('path parameters', () => {
  it('passes each decoded parameter to the handler', async () => {
    const app = createApp().get('/users/:id/posts/:post', c => c.json(c.req.params()))

    const response = await app.request('/users/42/posts/caf%C3%A9')

    expect(await response.json()).toEqual({ id: '42', post: 'café' })
  })

  it('splits the path before it decodes, so an encoded slash stays inside one parameter', async () => {
    const app = createApp().get('/files/:name', c => c.text(c.req.param('name') ?? 'missing'))

    const encoded = await app.request('/files/a%2Fb')
    const split = await app.request('/files/a/b')

    expect(await encoded.text()).toBe('a/b')
    expect(split.status).toBe(404)
  })

  it('sends a 400 with a JSON error when a parameter fails to decode', async () => {
    const app = createApp().get('/users/:id', c => c.text(c.req.param('id') ?? ''))

    const response = await app.request('/users/%E0%A4%A')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'INVALID_PATH_PARAMETER',
        message: 'A path parameter contains a percent sequence that fails to decode.',
      },
    })
  })

  it('wraps the 400 for a parameter that fails to decode with the app middleware', async () => {
    const app = createApp()
      .use(async (c, next) => {
        c.header('x-app', 'ran')
        await next()
      })
      .get('/users/:id', c => c.text('never'))

    const response = await app.request('/users/%ZZ')

    expect(response.status).toBe(400)
    expect(response.headers.get('x-app')).toBe('ran')
  })

  it('returns undefined for a parameter name that the route does not have', async () => {
    const app = createApp().get('/users/:id', c => c.json({ other: c.req.param('other') ?? null }))

    expect(await (await app.request('/users/1')).json()).toEqual({ other: null })
  })
})

describe('matching', () => {
  it('tries a static segment first and backtracks to a parameter when the static branch fails', async () => {
    const app = createApp()
      .get('/pages/about/team', c => c.text('static'))
      .get('/pages/:slug/edit', c => c.text(`parameter ${c.req.param('slug')}`))

    expect(await (await app.request('/pages/about/team')).text()).toBe('static')
    expect(await (await app.request('/pages/about/edit')).text()).toBe('parameter about')
  })

  it('treats /users and /users/ as two separate routes', async () => {
    const app = createApp()
      .get('/users', c => c.text('list'))
      .get('/users/', c => c.text('slash'))

    expect(await (await app.request('/users')).text()).toBe('list')
    expect(await (await app.request('/users/')).text()).toBe('slash')
  })

  it('sends a 404 for a trailing slash that no route has', async () => {
    const app = createApp().get('/users', c => c.text('list'))

    expect((await app.request('/users/')).status).toBe(404)
  })

  it('matches a path with its case', async () => {
    const app = createApp().get('/users', c => c.text('list'))

    const response = await app.request('/Users')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(NOT_FOUND_BODY)
  })

  it('lets a parameter match only a segment that is not empty', async () => {
    const app = createApp().get('/files/:folder/index', c => c.text('found'))

    expect((await app.request('/files//index')).status).toBe(404)
  })

  it('matches the root path', async () => {
    const app = createApp().get('/', c => c.text('home'))

    expect(await (await app.request('/')).text()).toBe('home')
  })

  it('matches a method in upper case alone', async () => {
    const app = createApp().get('/users', c => c.text('list'))

    const response = await app.request('/users', { method: 'get' })

    expect(response.status).toBe(405)
  })
})

describe('HEAD, OPTIONS, 405, and 404', () => {
  it('sends the headers and the length of the GET reply with no body for a HEAD request', async () => {
    const app = createApp().get('/users', c => c.json({ method: c.req.method }, 200, { 'x-total': '2' }))

    const response = await app.request('/users', { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('x-total')).toBe('2')
    expect(response.headers.get('content-length')).toBe(String('{"method":"HEAD"}'.length))
    expect(await response.text()).toBe('')
  })

  it('sends a 405 with an Allow header and a JSON error for a method that the path does not have', async () => {
    const app = createApp()
      .get('/users', c => c.text('list'))
      .post('/users', c => c.text('created', 201))

    const response = await app.request('/users', { method: 'PUT' })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
    expect(await response.json()).toEqual({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'This path has routes for GET, HEAD, POST, OPTIONS alone.' },
    })
  })

  it('puts every method whose routes match the path into Allow, across static and parameter routes', async () => {
    const app = createApp()
      .get('/users/:id', c => c.text('one'))
      .delete('/users/me', c => c.text('deleted'))

    const response = await app.request('/users/me', { method: 'PATCH' })

    expect(response.headers.get('allow')).toBe('GET, HEAD, DELETE, OPTIONS')
  })

  it('sends a 204 with the methods of the path for OPTIONS to a path that has routes', async () => {
    const app = createApp()
      .get('/users', c => c.text('list'))
      .patch('/users', c => c.text('patched'))

    const response = await app.request('/users', { method: 'OPTIONS' })

    expect(response.status).toBe(204)
    expect(response.headers.get('allow')).toBe('GET, HEAD, PATCH, OPTIONS')
    expect(await response.text()).toBe('')
  })

  it('calls an OPTIONS route in place of the Allow list', async () => {
    const app = createApp()
      .get('/users', c => c.text('list'))
      .options('/users', c => c.text('custom'))

    expect(await (await app.request('/users', { method: 'OPTIONS' })).text()).toBe('custom')
  })

  it('sends a JSON 404 for an unknown path, whatever the method', async () => {
    const app = createApp().get('/users', c => c.text('list'))

    for (const method of ['GET', 'POST', 'OPTIONS', 'HEAD', 'PROPFIND']) {
      const response = await app.request('/missing', { method })
      expect(response.status).toBe(404)
      if (method !== 'HEAD') expect(await response.json()).toEqual(NOT_FOUND_BODY)
    }
  })
})

describe('route registration', () => {
  it('throws INVALID_ROUTE for a path that the router cannot match', () => {
    for (const path of ['users', '/files/*', '/users/:id(\\d+)', '/a?b', '/a#b', '/:', '/café', '/a b', '/a:b']) {
      expect(() => createApp().get(path, c => c.text('x')), path).toThrow(UhttpError)
    }
  })

  it('throws for a parameter name that appears twice in one path', () => {
    expect(() => createApp().get('/:id/:id', c => c.text('x'))).toThrow(/appears twice/)
  })

  it('throws for a second route of the same shape, whatever the parameter names', () => {
    const app = createApp().get('/users/:id', c => c.text('first'))

    expect(() => app.get('/users/:name', c => c.text('second'))).toThrow(UhttpError)
    expect(() => app.post('/users/:name', c => c.text('post'))).not.toThrow()
  })

  it('throws for a path with more segments than uWebSockets.js matches', () => {
    const path = `/${Array.from({ length: 100 }, () => 'a').join('/')}`

    expect(() => createApp().get(path, c => c.text('deep'))).toThrow(UhttpError)
  })

  it('throws when the last argument is not a handler', () => {
    const app = createApp()

    expect(() => Reflect.apply(app.get, app, ['/users', { headers: ['accept'] }])).toThrow(UhttpError)
  })

  it('matches percent-encoded text in a static segment exactly as the client sent it', async () => {
    const app = createApp().get('/caf%C3%A9', c => c.text('coffee'))

    expect(await (await app.request('/caf%C3%A9')).text()).toBe('coffee')
    expect((await app.request('/caf%c3%a9')).status).toBe(404)
  })
})
