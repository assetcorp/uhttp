import { describe, expect, it } from 'vitest'
import { createApp, UhttpError } from '../../index.js'

const TEXT_CONTENT_TYPE = 'text/plain; charset=UTF-8'
const JSON_CONTENT_TYPE = 'application/json'
const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: 'The app has no route for this path.' } }
const INTERNAL_ERROR_BODY = { error: { code: 'INTERNAL_ERROR', message: 'The request failed.' } }

describe('app.request()', () => {
  it('returns the status, the headers, and the body of a GET route', async () => {
    const app = createApp().get('/hello', c => c.text('Hello, World!'))

    const response = await app.request('/hello')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(TEXT_CONTENT_TYPE)
    expect(await response.text()).toBe('Hello, World!')
  })

  it('returns JSON with the status that the handler passes', async () => {
    const app = createApp().get('/users', c => c.json({ users: ['Ama', 'Kofi'] }, 201))

    const response = await app.request('/users')

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE)
    expect(await response.json()).toEqual({ users: ['Ama', 'Kofi'] })
  })

  it('returns the reply of a handler that awaits before it returns', async () => {
    const app = createApp().get('/slow', async c => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return c.text('done')
    })

    const response = await app.request('/slow')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('done')
  })

  it('passes the method, the path, and the query string to the handler', async () => {
    const app = createApp().get('/search', c => c.json({ method: c.req.method, path: c.req.path, query: c.req.query }))

    const response = await app.request('/search?q=uhttp&page=2')

    expect(await response.json()).toEqual({ method: 'GET', path: '/search', query: 'q=uhttp&page=2' })
  })

  it('passes an empty query string to the handler when the target has no question mark', async () => {
    const app = createApp().get('/search', c => c.json({ method: c.req.method, path: c.req.path, query: c.req.query }))

    const response = await app.request('/search')

    expect(await response.json()).toEqual({ method: 'GET', path: '/search', query: '' })
  })

  it('returns a 204 without a body', async () => {
    const app = createApp().get('/empty', c => c.text('ignored', 204))

    const response = await app.request('/empty')

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('returns a JSON 404 for a path that has no route', async () => {
    const app = createApp().get('/hello', c => c.text('Hello, World!'))

    const response = await app.request('/missing')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE)
    expect(await response.json()).toEqual(NOT_FOUND_BODY)
  })

  it('returns a 500 with a generic message when a handler throws', async () => {
    const app = createApp().get('/broken', () => {
      throw new Error('database password is hunter2')
    })

    const response = await app.request('/broken')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual(INTERNAL_ERROR_BODY)
  })

  it('returns a 500 with a generic message when an async handler rejects', async () => {
    const app = createApp().get('/broken', async () => {
      await Promise.resolve()
      throw new Error('upstream timed out')
    })

    const response = await app.request('/broken')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual(INTERNAL_ERROR_BODY)
  })

  it('returns the status, the code, and the message of a typed error below 500', async () => {
    const app = createApp().get('/users/42', () => {
      throw new UhttpError('NOT_FOUND', 'No user has that id.')
    })

    const response = await app.request('/users/42')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No user has that id.' } })
  })

  it('replaces the message of a typed error that corresponds to 500', async () => {
    const app = createApp().get('/broken', () => {
      throw new UhttpError('INTERNAL_ERROR', 'the cache lost its connection')
    })

    const response = await app.request('/broken')

    expect(await response.json()).toEqual(INTERNAL_ERROR_BODY)
  })

  it('returns a 500 when a handler returns a value other than a reply', async () => {
    const app = createApp().get('/forgot', (() => 'Hello') as never)

    const response = await app.request('/forgot')

    expect(response.status).toBe(500)
  })

  it('returns a 500 when a handler passes a status below 200', async () => {
    const app = createApp().get('/odd', c => c.text('odd', 99))

    const response = await app.request('/odd')

    expect(response.status).toBe(500)
  })
})

describe('app.get()', () => {
  it('throws for a path that starts with a character other than a slash', () => {
    expect(() => createApp().get('hello', c => c.text('Hello'))).toThrow(UhttpError)
  })

  it('throws for a path with a wildcard', () => {
    expect(() => createApp().get('/files/*', c => c.text('file'))).toThrow(UhttpError)
  })

  it('throws for a second route to the same path', () => {
    const app = createApp().get('/hello', c => c.text('first'))

    expect(() => app.get('/hello', c => c.text('second'))).toThrow(UhttpError)
  })

  it('sets the code and the status on the error that it throws', () => {
    try {
      createApp().get('hello', c => c.text('Hello'))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(UhttpError)
      expect(error).toMatchObject({ code: 'INVALID_ROUTE', status: 500 })
    }
  })
})
