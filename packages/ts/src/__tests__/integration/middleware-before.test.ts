import { describe, expect, it } from 'vitest'
import { createApp, type Middleware, UhttpError } from '../../index.js'
import { pause } from '../helpers/server.js'

function beforeTracer(trace: string[], name: string): Middleware {
  return {
    before() {
      trace.push(`${name} before`)
    },
  }
}

function handleTracer(trace: string[], name: string): Middleware {
  return async (_c, next) => {
    trace.push(`${name} enter`)
    await next()
    trace.push(`${name} leave`)
  }
}

describe('before functions in the chain', () => {
  it('calls each before function in the order app, group, then route, between the handle functions', async () => {
    const trace: string[] = []
    const app = createApp()
    app.use(beforeTracer(trace, 'app'))
    app.use(handleTracer(trace, 'logger'))
    const admin = app.group('/admin', beforeTracer(trace, 'group'))
    admin.get('/stats', beforeTracer(trace, 'route'), c => {
      trace.push('handler')
      return c.text('stats')
    })

    const response = await app.request('/admin/stats')

    expect(await response.text()).toBe('stats')
    expect(trace).toEqual(['app before', 'logger enter', 'group before', 'route before', 'handler', 'logger leave'])
  })

  it('calls before and then handle on one object, and handle sees the reply after next()', async () => {
    const trace: string[] = []
    const app = createApp()
      .use({
        before() {
          trace.push('before')
        },
        async handle(c, next) {
          trace.push('handle')
          await next()
          trace.push(`after ${c.reply?.status}`)
        },
      })
      .get('/orders', c => c.json({ orders: [] }, 201))

    const response = await app.request('/orders')

    expect(response.status).toBe(201)
    expect(trace).toEqual(['before', 'handle', 'after 201'])
  })

  it('ends the request with the reply that before returns, so neither handle, inner middleware, nor the handler runs', async () => {
    const trace: string[] = []
    const app = createApp()
      .use(handleTracer(trace, 'outer'))
      .use({
        before: c => c.json({ error: 'login required' }, 401),
        handle(_c, next) {
          trace.push('handle')
          return next()
        },
      })
      .use(beforeTracer(trace, 'inner'))
      .get('/account', c => {
        trace.push('handler')
        return c.text('account')
      })

    const response = await app.request('/account')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'login required' })
    expect(trace).toEqual(['outer enter', 'outer leave'])
  })

  it('waits for a promise from before, and passes the request on when it resolves without a reply', async () => {
    const trace: string[] = []
    const app = createApp()
      .use({
        async before() {
          await pause(5)
          trace.push('checked')
        },
      })
      .get('/slow', c => {
        trace.push('handler')
        return c.text('done')
      })

    const response = await app.request('/slow')

    expect(await response.text()).toBe('done')
    expect(trace).toEqual(['checked', 'handler'])
  })

  it('ends the request with the reply of a promise from before', async () => {
    let handled = false
    const app = createApp()
      .use({
        async before(c) {
          await pause(1)
          return c.text('maintenance', 503)
        },
      })
      .get('/shop', c => {
        handled = true
        return c.text('shop')
      })

    const response = await app.request('/shop')

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('maintenance')
    expect(handled).toBe(false)
  })

  it('turns an error from before into the reply that the outer handle function sees, for a throw and for a rejection', async () => {
    const seen: number[] = []
    const failing = (error: UhttpError): Middleware[] => [
      {
        before() {
          throw error
        },
      },
      {
        async before() {
          await pause(1)
          throw error
        },
      },
    ]
    for (const middleware of failing(new UhttpError('NOT_FOUND', 'The account has no report of that name.'))) {
      let handled = false
      const app = createApp()
        .use(async (c, next) => {
          await next()
          seen.push(c.reply?.status ?? 0)
        })
        .use(middleware)
        .get('/report', c => {
          handled = true
          return c.text('report')
        })

      const response = await app.request('/report')

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: { code: 'NOT_FOUND', message: 'The account has no report of that name.' },
      })
      expect(handled).toBe(false)
    }
    expect(seen).toEqual([404, 404])
  })

  it('sends a 500 and logs the error when before throws something other than a UhttpError', async () => {
    const logged: unknown[] = []
    const logger = { info() {}, warn() {}, error: (details: object) => logged.push(details) }
    const app = createApp({ logger })
      .use({
        before() {
          throw new TypeError('The session store is down.')
        },
      })
      .get('/cart', c => c.text('cart'))

    const response = await app.request('/cart')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'The request failed.' } })
    expect(logged).toHaveLength(1)
  })

  it('waits for a thenable from before that is not a native promise, and never calls the handler when it refuses', async () => {
    let handled = false
    const thenableOf = (settle: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => void) =>
      Object.fromEntries([['then', settle]]) as unknown as Promise<undefined>
    const app = createApp()
      .use({
        headers: ['x-session'],
        before: c => {
          const session = c.req.header('x-session')
          if (session === 'expired') {
            return thenableOf((_resolve, reject) => {
              setTimeout(() => reject(new UhttpError('NOT_FOUND', 'The session has expired.')), 1)
            })
          }
          if (session === 'missing') {
            return thenableOf(resolve => {
              setTimeout(() => resolve(c.json({ error: 'sign in' }, 401)), 1)
            })
          }
          return thenableOf(resolve => resolve(undefined))
        },
      })
      .get('/basket', c => {
        handled = true
        return c.text('basket')
      })

    const expired = await app.request('/basket', { headers: { 'x-session': 'expired' } })
    const missing = await app.request('/basket', { headers: { 'x-session': 'missing' } })

    expect([expired.status, missing.status]).toEqual([404, 401])
    expect(await missing.json()).toEqual({ error: 'sign in' })
    expect(handled).toBe(false)
    expect(await (await app.request('/basket', { headers: { 'x-session': 'valid' } })).text()).toBe('basket')
  })

  it('sends a 500 when reading the then property of the value from before throws', async () => {
    const trap = Object.defineProperty({}, 'then', {
      get() {
        throw new TypeError('The session proxy is closed.')
      },
    })
    let handled = false
    const app = createApp()
      .use({ before: () => trap as unknown as undefined })
      .get('/basket', c => {
        handled = true
        return c.text('basket')
      })

    const response = await app.request('/basket')

    expect(response.status).toBe(500)
    expect(handled).toBe(false)
  })

  it('passes the request on when before returns a value other than a reply', async () => {
    const app = createApp()
      .use({ before: () => 'ignored' as unknown as undefined })
      .use({ before: async () => 42 as unknown as undefined })
      .get('/items', c => c.text('items'))

    expect(await (await app.request('/items')).text()).toBe('items')
  })

  it('calls before for a 404, a 405, and an OPTIONS answer', async () => {
    let calls = 0
    const app = createApp()
      .use({
        before() {
          calls++
        },
      })
      .get('/users', c => c.text('users'))

    const missing = await app.request('/missing')
    const refused = await app.request('/users', { method: 'DELETE' })
    const options = await app.request('/users', { method: 'OPTIONS' })

    expect([missing.status, refused.status, options.status]).toEqual([404, 405, 204])
    expect(calls).toBe(3)
  })

  it('calls the before function of a group only for a raw path under the prefix', async () => {
    let calls = 0
    const app = createApp()
    app.group('/admin', {
      before() {
        calls++
      },
    })
    app.get('/admin/:page', c => c.text(c.req.param('page') ?? ''))
    app.get('/:page', c => c.text(c.req.param('page') ?? ''))

    await app.request('/admin/stats')
    await app.request('/administrator')
    await app.request('/home')

    expect(calls).toBe(1)
  })

  it('copies the headers that a before middleware declares', async () => {
    const app = createApp()
      .use({
        headers: ['x-api-key'],
        before: c => (c.req.header('x-api-key') === 'key-1' ? undefined : c.json({ error: 'bad key' }, 401)),
      })
      .get('/data', c => c.text('data'))

    const allowed = await app.request('/data', { headers: { 'x-api-key': 'key-1' } })
    const refused = await app.request('/data', { headers: { 'x-api-key': 'key-2' } })

    expect([allowed.status, refused.status]).toEqual([200, 401])
  })

  it('throws INVALID_ROUTE for a before or a handle that is not a function', () => {
    const app = createApp()
    const before = { before: 'check', handle: (_c: unknown, next: () => Promise<void>) => next() }
    const handle = { before: () => undefined, handle: 42 }
    expect(() => app.use(before as unknown as Middleware)).toThrow(
      'Set the before of a middleware to a function, or leave it out.',
    )
    expect(() => app.use(handle as unknown as Middleware)).toThrow(
      'Set the handle of a middleware to a function, or leave it out.',
    )
    expect(() => app.use({} as unknown as Middleware)).toThrow(
      'Pass each middleware as a function or as an object with a before function, a handle function, or both.',
    )
  })

  it('throws INVALID_ROUTE for a route middleware whose before or handle is set to a value other than a function', () => {
    const app = createApp()
    const checkLogin = { headers: ['authorization'], before: 'check' }
    const misspelled = { headers: ['authorization'], before: undefined }
    const handled = { handle: null }
    const add = (middleware: object) => () =>
      app.get('/account', middleware as unknown as Middleware, c => c.text('account'))
    expect(add(checkLogin)).toThrow('Set the before of a middleware to a function, or leave it out.')
    expect(add(misspelled)).toThrow(
      'Pass each middleware as a function or as an object with a before function, a handle function, or both.',
    )
    expect(add(handled)).toThrow(expect.objectContaining({ code: 'INVALID_ROUTE' }))
  })

  it('throws INVALID_ROUTE for a WebSocket route whose last argument is a before middleware', () => {
    const app = createApp()
    expect(() => app.ws('/live', { before: () => undefined } as never)).toThrow(UhttpError)
  })
})
