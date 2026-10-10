import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'

const PARSER_ERROR_BODY = '<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>'

function headersApp() {
  return createApp().get('/headers', { headers: 'all' }, c => c.json(c.req.headers()))
}

async function expectParserError(response: Response): Promise<void> {
  expect(response.status).toBe(400)
  expect(response.headers.get('connection')).toBe('close')
  expect(await response.text()).toBe(PARSER_ERROR_BODY)
}

afterEach(() => {
  delete process.env.UWS_HTTP_MAX_HEADERS_SIZE
})

describe('app.request()', () => {
  it('lowercases header names and trims the spaces around each value', async () => {
    const response = await headersApp().request('/headers', { headers: { 'X-Mixed-Case': '  padded\t' } })

    expect(await response.json()).toEqual({ host: 'localhost', 'x-mixed-case': 'padded' })
  })

  it('sends host: localhost when the headers include no host, as fetch does', async () => {
    const response = await headersApp().request('/headers')

    expect(await response.json()).toEqual({ host: 'localhost' })
  })

  it('returns the 400 of uWebSockets.js for an empty, repeated, or invalid Host', async () => {
    const app = headersApp()

    await expectParserError(await app.request('/headers', { headers: { host: '' } }))
    await expectParserError(
      await app.request('/headers', {
        headers: [
          ['host', 'a.example'],
          ['Host', 'b.example'],
        ],
      }),
    )
    for (const host of ['a b', 'a,b', 'user@example.com']) {
      await expectParserError(await app.request('/headers', { headers: { host } }))
    }
  })

  it('returns 200 for 98 header lines and 400 for 99', async () => {
    const app = headersApp()
    const lines = (count: number) => Array.from({ length: count - 1 }, (_, index) => [`x-${index}`, 'v'] as const)

    expect((await app.request('/headers', { headers: lines(98) })).status).toBe(200)
    await expectParserError(await app.request('/headers', { headers: lines(99) }))
  })

  it('returns 200 for a head of 4,096 bytes and 400 above that', async () => {
    const app = headersApp()
    const head = (bytes: number) => {
      const fixed = 'GET /headers HTTP/1.1\r\nhost: localhost\r\nx-pad: \r\n\r\n'.length
      return { headers: { 'x-pad': 'a'.repeat(bytes - fixed) } }
    }

    expect((await app.request('/headers', head(4096))).status).toBe(200)
    await expectParserError(await app.request('/headers', head(4097)))
  })

  it('follows UWS_HTTP_MAX_HEADERS_SIZE as uWebSockets.js does', async () => {
    process.env.UWS_HTTP_MAX_HEADERS_SIZE = '8192'

    const response = await headersApp().request('/headers', { headers: { 'x-pad': 'a'.repeat(6000) } })

    expect(response.status).toBe(200)
  })

  it('returns 400 for an invalid header name or a control character in a value', async () => {
    const app = headersApp()

    await expectParserError(await app.request('/headers', { headers: { 'bad name': 'v' } }))
    await expectParserError(await app.request('/headers', { headers: { 'x-bad': 'a\u0001b' } }))
  })

  it('returns 400 for a target that does not start with a slash or that contains a space', async () => {
    const app = headersApp()

    await expectParserError(await app.request('headers'))
    await expectParserError(await app.request('/head ers'))
  })

  it('returns 400 for a request with both Content-Length and Transfer-Encoding, or with conflicting lengths', async () => {
    const app = createApp().post('/upload', c => c.text('ok'))

    await expectParserError(
      await app.request('/upload', {
        method: 'POST',
        headers: { 'content-length': '0', 'transfer-encoding': 'chunked' },
      }),
    )
    await expectParserError(
      await app.request('/upload', {
        method: 'POST',
        headers: [
          ['content-length', '1'],
          ['content-length', '2'],
        ],
      }),
    )
    await expectParserError(await app.request('/upload', { method: 'POST', headers: { 'content-length': '1e3' } }))
    await expectParserError(
      await app.request('/upload', { method: 'POST', headers: { 'content-length': '1000000000000000000' } }),
    )
    await expectParserError(await app.request('/upload', { method: 'POST', headers: { 'transfer-encoding': 'gzip' } }))
  })

  it('accepts a Content-Length of 18 digits, as uWebSockets.js does, and answers 413 to its size', async () => {
    const app = createApp().post('/upload', c => c.text('ok'))

    const response = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-length': '100000000000000000' },
    })

    expect(response.status).toBe(413)
  })

  it.each([
    ['xchunked', 400, 'INVALID_TRANSFER_ENCODING'],
    ['chunked, chunked', 400, 'INVALID_TRANSFER_ENCODING'],
    ['gzip, chunked', 501, 'UNSUPPORTED_TRANSFER_CODING'],
  ])(
    'answers a Transfer-Encoding of %s with %i and %s before any handler runs, and closes the connection',
    async (encoding, status, code) => {
      let handled = false
      const app = createApp().post('/upload', c => {
        handled = true
        return c.text('ok')
      })

      const response = await app.request('/upload', {
        method: 'POST',
        headers: { 'transfer-encoding': encoding },
        body: ['hello'],
      })

      expect(response.status).toBe(status)
      expect(response.headers.get('connection')).toBe('close')
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code)
      expect(handled).toBe(false)
    },
  )

  it('reads a body sent with a Transfer-Encoding of Chunked in another case', async () => {
    const app = createApp().post('/upload', async c => c.text(await c.req.body.text()))

    const response = await app.request('/upload', {
      method: 'POST',
      headers: { 'transfer-encoding': 'Chunked', 'content-type': 'text/plain' },
      body: ['hel', 'lo'],
    })

    expect(await response.text()).toBe('hello')
  })
})
