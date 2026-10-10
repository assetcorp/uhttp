import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type Server, serve, UhttpError } from '../index.js'

const HOST = '127.0.0.1'

let server: Server | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function url(path: string): string {
  if (server === undefined) throw new Error('The test started no server.')
  return `http://${HOST}:${server.port}${path}`
}

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

describe('serve()', () => {
  it('serves a GET route over the network on the port that the operating system assigns for port 0', async () => {
    server = await serve({ app: createApp().get('/hello', c => c.text('Hello, World!')), port: 0, host: HOST })

    const response = await fetch(url('/hello'))

    expect(server.port).toBeGreaterThan(0)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=UTF-8')
    expect(await response.text()).toBe('Hello, World!')
  })

  it('sends the reply of a handler that awaits before it returns', async () => {
    const app = createApp().get('/slow', async c => {
      await pause(5)
      return c.json({ ready: true }, 202)
    })
    server = await serve({ app, port: 0, host: HOST })

    const response = await fetch(url('/slow'))

    expect(response.status).toBe(202)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ ready: true })
  })

  it('passes the method, the path, and the query string from the network to the handler', async () => {
    server = await serve({ app: createApp().get('/search', c => c.json({ ...c.req })), port: 0, host: HOST })

    const response = await fetch(url('/search?q=uhttp&page=2'))

    expect(await response.json()).toEqual({ method: 'GET', path: '/search', query: 'q=uhttp&page=2' })
  })

  it('passes an empty query string to the handler when the URL has no question mark', async () => {
    server = await serve({ app: createApp().get('/search', c => c.json({ ...c.req })), port: 0, host: HOST })

    const response = await fetch(url('/search'))

    expect(await response.json()).toEqual({ method: 'GET', path: '/search', query: '' })
  })

  it('returns the same JSON 404 as app.request() for a path that has no route', async () => {
    server = await serve({ app: createApp().get('/hello', c => c.text('Hello')), port: 0, host: HOST })

    const response = await fetch(url('/missing'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'The app has no route for this path.' },
    })
  })

  it('sends a 204 without a body', async () => {
    server = await serve({ app: createApp().get('/empty', c => c.text('ignored', 204)), port: 0, host: HOST })

    const response = await fetch(url('/empty'))

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('returns a 500 with a generic message when a handler throws or rejects', async () => {
    const app = createApp()
      .get('/throws', () => {
        throw new Error('secret')
      })
      .get('/rejects', async () => {
        await pause(1)
        throw new Error('secret')
      })
    server = await serve({ app, port: 0, host: HOST })

    for (const path of ['/throws', '/rejects']) {
      const response = await fetch(url(path))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'The request failed.' },
      })
    }
  })

  it('serves the next request after a client disconnects before its handler returns', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const answered = Promise.withResolvers<void>()
    const app = createApp()
      .get('/slow', async c => {
        started.resolve()
        await release.promise
        answered.resolve()
        return c.text('late')
      })
      .get('/hello', c => c.text('Hello'))
    server = await serve({ app, port: 0, host: HOST })

    const controller = new AbortController()
    const abandoned = fetch(url('/slow'), { signal: controller.signal })
    await started.promise
    controller.abort()
    await expect(abandoned).rejects.toThrow()
    await pause(50)
    release.resolve()
    await answered.promise
    await pause(10)

    const response = await fetch(url('/hello'))
    expect(await response.text()).toBe('Hello')
  })

  it('closes its socket, so that a later fetch rejects', async () => {
    server = await serve({ app: createApp().get('/hello', c => c.text('Hello')), port: 0, host: HOST })
    const address = url('/hello')

    await server.close()

    await expect(fetch(address)).rejects.toThrow()
  })

  it('returns the same promise from a second call to close()', async () => {
    server = await serve({ app: createApp(), port: 0, host: HOST })

    expect(server.close()).toBe(server.close())
  })

  it('listens on every interface when you leave out the host', async () => {
    server = await serve({ app: createApp().get('/hello', c => c.text('Hello')), port: 0 })

    const response = await fetch(url('/hello'))

    expect(await response.text()).toBe('Hello')
  })

  it('throws for a port outside the TCP range of 0 to 65535', async () => {
    for (const port of [-1, 65_536, 1.5, Number.NaN]) {
      await expect(serve({ app: createApp(), port })).rejects.toMatchObject({ code: 'INVALID_SERVE_OPTIONS' })
    }
  })

  it('rejects with a typed error when the operating system cannot bind the address', async () => {
    await expect(serve({ app: createApp(), port: 0, host: '203.0.113.1' })).rejects.toBeInstanceOf(UhttpError)
  })
})
