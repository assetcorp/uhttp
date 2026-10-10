import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { errorCodeOf } from '../helpers/body.js'

const MIB = 1_048_576

async function* chunksOf(sizes: readonly number[]): AsyncGenerator<Uint8Array> {
  for (const size of sizes) yield new Uint8Array(size).fill(120)
}

function countingApp(options: { maxBodyBytes?: number } = {}) {
  return createApp(options).post('/count', async c => {
    let total = 0
    const sizes: number[] = []
    for await (const chunk of c.req.body.stream()) {
      total += chunk.byteLength
      sizes.push(chunk.byteLength)
    }
    return c.json({ total, sizes })
  })
}

describe('the body stream through app.request()', () => {
  it('yields the body as byte chunks in the order that the client sent them', async () => {
    const app = createApp().post('/echo', async c => {
      const parts: string[] = []
      for await (const chunk of c.req.body.stream()) parts.push(Buffer.from(chunk).toString())
      return c.json(parts)
    })

    const response = await app.request('/echo', { method: 'POST', body: ['one', 'two', 'three'] })

    expect(await response.json()).toEqual(['one', 'two', 'three'])
  })

  it('yields copies that stay intact after the next chunk arrives', async () => {
    const app = createApp().post('/keep', async c => {
      const kept: Uint8Array[] = []
      for await (const chunk of c.req.body.stream()) kept.push(chunk)
      return c.text(kept.map(chunk => Buffer.from(chunk).toString()).join('|'))
    })

    const response = await app.request('/keep', { method: 'POST', body: ['aaa', 'bbb'] })

    expect(await response.text()).toBe('aaa|bbb')
  })

  it('reads a body that arrives while a middleware awaits before the handler', async () => {
    const app = createApp()
      .use(async (_c, next) => {
        await new Promise(resolve => setTimeout(resolve, 20))
        await next()
      })
      .put('/late', async c => c.text(await c.req.body.text()))

    const response = await app.request('/late', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'still here',
    })

    expect(await response.text()).toBe('still here')
  })

  it('reads an empty body when the request declares no length and no chunked encoding', async () => {
    const app = createApp().patch('/empty', async c => c.text(`[${await c.req.body.text()}]`))

    const response = await app.request('/empty', { method: 'PATCH', headers: { 'content-type': 'text/plain' } })

    expect(await response.text()).toBe('[]')
  })
})

describe('body limits through app.request()', () => {
  it('accepts a body of exactly 1 MiB by default and answers 413 to one byte more', async () => {
    const app = countingApp()

    const within = await app.request('/count', { method: 'POST', body: new Uint8Array(MIB) })
    const beyond = await app.request('/count', { method: 'POST', body: chunksOf([MIB, 1]) })

    expect(((await within.json()) as { total: number }).total).toBe(MIB)
    expect(beyond.status).toBe(413)
    expect(await errorCodeOf(beyond)).toBe('PAYLOAD_TOO_LARGE')
  })

  it('counts the bytes as they arrive, so a chunked body without a declared length still meets the limit', async () => {
    const app = countingApp({ maxBodyBytes: 10 })

    const response = await app.request('/count', { method: 'POST', body: chunksOf([4, 4, 4]) })

    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toBe('close')
  })

  it('answers 413 to a declared length above the limit before it reads any of the body', async () => {
    let pulled = 0
    async function* tracked(): AsyncGenerator<Uint8Array> {
      pulled++
      yield new Uint8Array(20)
    }
    let handled = false
    const app = createApp({ maxBodyBytes: 10 }).post('/upload', c => {
      handled = true
      return c.text('ok')
    })

    const response = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-length': '20' },
      body: tracked(),
    })

    expect(response.status).toBe(413)
    expect(await errorCodeOf(response)).toBe('PAYLOAD_TOO_LARGE')
    expect(response.headers.get('connection')).toBe('close')
    expect(handled).toBe(false)
    expect(pulled).toBe(0)
  })

  it('passes the early 413 through the middleware of the route', async () => {
    const app = createApp({ maxBodyBytes: 4 })
      .use(async (c, next) => {
        c.header('x-seen', 'yes')
        await next()
      })
      .post('/upload', c => c.text('ok'))

    const response = await app.request('/upload', { method: 'POST', body: 'too long' })

    expect(response.status).toBe(413)
    expect(response.headers.get('x-seen')).toBe('yes')
  })

  it('lets a route raise or lower the default limit of the app', async () => {
    const app = createApp({ maxBodyBytes: 8 })
      .post('/small', { maxBodyBytes: 2 }, async c => c.text(await c.req.body.text()))
      .post('/large', { maxBodyBytes: 32 }, async c => c.text(await c.req.body.text()))

    const small = await app.request('/small', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'abc',
    })
    const large = await app.request('/large', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'a body of twenty-four b',
    })

    expect(small.status).toBe(413)
    expect(await large.text()).toBe('a body of twenty-four b')
  })

  it('keeps the connection open after a body that the handler read in full', async () => {
    const app = countingApp()

    const response = await app.request('/count', { method: 'POST', body: 'short' })

    expect(response.status).toBe(200)
    expect(response.headers.get('connection')).toBeNull()
  })

  it('refuses a limit that is not a whole number of bytes', () => {
    expect(() => createApp({ maxBodyBytes: -1 })).toThrow(expect.objectContaining({ code: 'INVALID_APP_OPTIONS' }))
    expect(() => createApp({ maxBodyBytes: 1.5 })).toThrow(expect.objectContaining({ code: 'INVALID_APP_OPTIONS' }))
    expect(() => createApp().post('/x', { maxBodyBytes: Number.NaN }, c => c.text(''))).toThrow(
      expect.objectContaining({ code: 'INVALID_ROUTE' }),
    )
  })
})

describe('the routes that get a body reader', () => {
  it('attaches a reader on POST, PUT, and PATCH routes by default', async () => {
    const app = createApp()
      .post('/x', async c => c.text(await c.req.body.text()))
      .put('/x', async c => c.text(await c.req.body.text()))
      .patch('/x', async c => c.text(await c.req.body.text()))

    for (const method of ['POST', 'PUT', 'PATCH']) {
      const response = await app.request('/x', { method, headers: { 'content-type': 'text/plain' }, body: method })
      expect(await response.text()).toBe(method)
    }
  })

  it('answers 500 with UNDECLARED_BODY when a GET or DELETE route reads a body without opting in', async () => {
    const codes: string[] = []
    const app = createApp({
      onError: (error, c) => {
        codes.push((error as { code: string }).code)
        return c.text('failed', 500)
      },
    })
      .get('/x', async c => c.text(await c.req.body.text()))
      .delete('/x', async c => c.text(await c.req.body.text()))

    await app.request('/x')
    await app.request('/x', { method: 'DELETE', body: 'gone' })

    expect(codes).toEqual(['UNDECLARED_BODY', 'UNDECLARED_BODY'])
  })

  it('attaches a reader on any route that opts in, and leaves it off a POST route that opts out', async () => {
    const app = createApp()
      .delete('/x', { body: true }, async c => c.text(await c.req.body.text()))
      .post('/y', { body: false }, async c => c.text(await c.req.body.text()))

    const optedIn = await app.request('/x', {
      method: 'DELETE',
      headers: { 'content-type': 'text/plain' },
      body: 'ids',
    })
    const optedOut = await app.request('/y', { method: 'POST', body: 'ids' })

    expect(await optedIn.text()).toBe('ids')
    expect(optedOut.status).toBe(500)
  })
})
