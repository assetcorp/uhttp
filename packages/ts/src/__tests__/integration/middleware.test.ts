import { describe, expect, it } from 'vitest'
import { createApp, type Middleware, UhttpError } from '../../index.js'
import { pause } from '../helpers/server.js'

function tracer(trace: string[], name: string): Middleware {
  return async (_c, next) => {
    trace.push(`${name} before`)
    await next()
    trace.push(`${name} after`)
  }
}

describe('middleware order', () => {
  it('wraps a route in the order app, group, then route, whenever you added each', async () => {
    const trace: string[] = []
    const app = createApp()
    const admin = app.group('/admin', tracer(trace, 'group'))
    admin.get('/stats', tracer(trace, 'route'), c => {
      trace.push('handler')
      return c.text('stats')
    })
    app.use(tracer(trace, 'app'))

    await app.request('/admin/stats')

    expect(trace).toEqual([
      'app before',
      'group before',
      'route before',
      'handler',
      'route after',
      'group after',
      'app after',
    ])
  })

  it('wraps nested groups from the outer prefix to the inner one', async () => {
    const trace: string[] = []
    const app = createApp()
    const api = app.group('/api', tracer(trace, 'api'))
    api.group('/v1', tracer(trace, 'v1')).get('/users', c => c.text('users'))

    await app.request('/api/v1/users')

    expect(trace).toEqual(['api before', 'v1 before', 'v1 after', 'api after'])
  })

  it('lets a middleware end the request with its own reply before the handler starts', async () => {
    let handled = false
    const app = createApp()
    app
      .group('/admin', c => c.json({ error: 'login required' }, 401))
      .get('/stats', c => {
        handled = true
        return c.text('stats')
      })

    const response = await app.request('/admin/stats')

    expect(response.status).toBe(401)
    expect(handled).toBe(false)
  })

  it('lets a middleware replace the reply after next()', async () => {
    const app = createApp()
      .use(async (c, next) => {
        await next()
        return c.text(`wrapped ${c.reply?.status}`)
      })
      .get('/users', c => c.text('list', 202))

    expect(await (await app.request('/users')).text()).toBe('wrapped 202')
  })
})

describe('prefix guards', () => {
  it('guards a route that you added outside the group when its raw path starts with the prefix', async () => {
    const app = createApp()
    app.group('/admin', c => c.text('blocked', 403))
    app.get('/:section/settings', c => c.text(`settings of ${c.req.param('section')}`))

    expect((await app.request('/admin/settings')).status).toBe(403)
    expect(await (await app.request('/public/settings')).text()).toBe('settings of public')
  })

  it('matches the prefix at a segment boundary', async () => {
    const app = createApp().get('/administrator', c => c.text('open'))
    app.group('/admin', c => c.text('blocked', 403))

    expect(await (await app.request('/administrator')).text()).toBe('open')
    expect((await app.request('/admin')).status).toBe(403)
  })

  it('compares raw segments, so an encoded spelling of the prefix matches neither the guard nor a route', async () => {
    const app = createApp()
    app.group('/admin', c => c.text('blocked', 403)).get('/stats', c => c.text('stats'))

    const response = await app.request('/%61dmin/stats')

    expect(response.status).toBe(404)
  })

  it('wraps a 404, a 405, and an OPTIONS answer under the prefix', async () => {
    const app = createApp()
    app
      .group('/api', async (c, next) => {
        c.header('access-control-allow-origin', 'https://example.com')
        await next()
      })
      .get('/users', c => c.text('users'))

    const missing = await app.request('/api/missing')
    const wrongMethod = await app.request('/api/users', { method: 'POST' })
    const preflight = await app.request('/api/users', { method: 'OPTIONS' })
    const outside = await app.request('/elsewhere')

    expect([missing.status, wrongMethod.status, preflight.status]).toEqual([404, 405, 204])
    for (const response of [missing, wrongMethod, preflight]) {
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com')
    }
    expect(outside.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('wraps the 404, 405, and OPTIONS answers with the app middleware', async () => {
    const seen: string[] = []
    const app = createApp()
      .use(async (c, next) => {
        await next()
        seen.push(`${c.req.method} ${c.reply?.status}`)
      })
      .get('/users', c => c.text('users'))

    await app.request('/missing')
    await app.request('/users', { method: 'DELETE' })
    await app.request('/users', { method: 'OPTIONS' })

    expect(seen).toEqual(['GET 404', 'DELETE 405', 'OPTIONS 204'])
  })

  it('throws INVALID_ROUTE for a group prefix with a trailing slash or an empty segment', () => {
    for (const prefix of ['/admin/', '/a//b', 'admin']) {
      expect(() => createApp().group(prefix), prefix).toThrow(UhttpError)
    }
  })

  it('maps / inside a group to the group prefix', async () => {
    const app = createApp()
    app.group('/admin').get('/', c => c.text('admin home'))

    expect(await (await app.request('/admin')).text()).toBe('admin home')
  })
})

describe('errors at middleware boundaries', () => {
  it('turns a thrown error into a reply before the outer middleware resumes', async () => {
    let seenStatus: number | undefined
    const app = createApp()
      .use(async (c, next) => {
        c.header('access-control-allow-origin', '*')
        await next()
        seenStatus = c.reply?.status
      })
      .get('/broken', () => {
        throw new UhttpError('NOT_FOUND', 'No user has that id.')
      })

    const response = await app.request('/broken')

    expect(seenStatus).toBe(404)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No user has that id.' } })
  })

  it('turns an error that a middleware throws after next() into the reply', async () => {
    const app = createApp()
      .use(async (_c, next) => {
        await next()
        throw new Error('the audit log is down')
      })
      .get('/users', c => c.text('list'))

    const response = await app.request('/users')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'The request failed.' } })
  })

  it('sends a 500 when a middleware calls next() twice', async () => {
    const app = createApp()
      .use(async (_c, next) => {
        await next()
        await next()
      })
      .get('/users', c => c.text('list'))

    expect((await app.request('/users')).status).toBe(500)
  })

  it('sends a 500 when the chain ends without a reply', async () => {
    const app = createApp()
      .use(() => undefined)
      .get('/users', c => c.text('list'))

    expect((await app.request('/users')).status).toBe(500)
  })

  it('calls a middleware object that declares nothing', async () => {
    const app = createApp()
      .use({ handle: (_c, next) => next() })
      .get('/users', c => c.text('list'))

    expect(await (await app.request('/users')).text()).toBe('list')
  })

  it('passes the values that a middleware stores with c.set to later middleware and the handler, after an await', async () => {
    const app = createApp()
      .use(async (c, next) => {
        c.set('user', { id: 7 })
        c.set('__proto__', 'kept as a key')
        await pause(1)
        await next()
      })
      .use(async (c, next) => {
        c.set('role', 'admin')
        c.set('role', 'owner')
        await next()
      })
      .get('/me', async c => {
        await pause(1)
        return c.json({ user: c.get('user'), role: c.get('role'), proto: c.get('__proto__'), missing: c.get('x') })
      })

    expect(await (await app.request('/me')).json()).toEqual({
      user: { id: 7 },
      role: 'owner',
      proto: 'kept as a key',
    })
  })

  it('starts every request with no stored values', async () => {
    const app = createApp().get('/count', c => {
      const seen = c.get('count')
      c.set('count', 1)
      return c.json({ seen: seen ?? null })
    })

    await app.request('/count')

    expect(await (await app.request('/count')).json()).toEqual({ seen: null })
  })

  it('throws INVALID_ROUTE for an entry that is not a middleware', () => {
    const app = createApp()

    expect(() => Reflect.apply(app.use, app, [42])).toThrow(UhttpError)
    expect(() => Reflect.apply(app.use, app, [{ headers: 'cookie', handle: () => undefined }])).toThrow(UhttpError)
  })
})
