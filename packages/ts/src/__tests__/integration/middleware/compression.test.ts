import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { type Context, createApp, type Reply } from '../../../index.js'
import { type CompressionOptions, compression, skipCompression } from '../../../middleware/compression/index.js'

const LARGE_TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
const LARGE_JSON = { items: Array.from({ length: 200 }, (_, index) => ({ id: index, name: `item ${index}` })) }

function decoded(encoding: string | null, bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes)
  if (encoding === 'br') return brotliDecompressSync(buffer).toString()
  if (encoding === 'gzip') return gunzipSync(buffer).toString()
  if (encoding === 'zstd') return zstdDecompressSync(buffer).toString()
  return buffer.toString()
}

function compressedApp(handler: (c: Context) => Reply | Promise<Reply>, options?: CompressionOptions) {
  return createApp().use(compression(options)).get('/', handler)
}

async function encodingFor(handler: (c: Context) => Reply, acceptEncoding: string) {
  return (await fetchWith(compressedApp(handler), acceptEncoding)).encoding
}

async function fetchWith(app: ReturnType<typeof compressedApp>, acceptEncoding?: string, method = 'GET') {
  const response = await app.request('/', {
    method,
    headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { response, bytes, encoding: response.headers.get('content-encoding') }
}

function varyOf(response: Response): string[] {
  return (response.headers.get('vary') ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry !== '')
}

describe('compression() negotiation', () => {
  it.each([
    ['br', 'br'],
    ['gzip', 'gzip'],
    ['zstd', 'zstd'],
    ['gzip, deflate, br, zstd', 'br'],
    ['gzip;q=1, br;q=0.5', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['*', 'br'],
    ['*;q=0.1, gzip;q=0.5', 'gzip'],
    ['BR', 'br'],
  ])('answers %j with %s', async (accept, expected) => {
    const { response, bytes, encoding } = await fetchWith(
      compressedApp(c => c.text(LARGE_TEXT)),
      accept,
    )
    expect(encoding).toBe(expected)
    expect(decoded(encoding, bytes)).toBe(LARGE_TEXT)
    expect(Number(response.headers.get('content-length'))).toBe(bytes.byteLength)
    expect(bytes.byteLength).toBeLessThan(Buffer.byteLength(LARGE_TEXT))
  })

  it.each([undefined, 'identity', 'deflate', 'br;q=0, gzip;q=0, zstd;q=0', '*;q=0', 'gzip;q=abc', ''])(
    'sends the body unencoded for %j',
    async accept => {
      const app = compressedApp(c => c.text(LARGE_TEXT))
      const { response, bytes, encoding } = await fetchWith(app, accept)
      expect(encoding).toBe(null)
      expect(Buffer.from(bytes).toString()).toBe(LARGE_TEXT)
      expect(varyOf(response)).toEqual(['accept-encoding'])
    },
  )

  it('compresses with Brotli at quality 4 in text mode', async () => {
    const body = Buffer.from(JSON.stringify(LARGE_JSON))
    const quality = (level: number) =>
      brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: level,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
        },
      })
    const { bytes, encoding } = await fetchWith(
      compressedApp(c => c.json(LARGE_JSON)),
      'br',
    )
    expect(encoding).toBe('br')
    expect(Buffer.from(bytes).equals(quality(4))).toBe(true)
    expect(quality(4).equals(quality(11))).toBe(false)
  })

  it('uses your order of encodings', async () => {
    const app = compressedApp(c => c.text(LARGE_TEXT), { encodings: ['gzip', 'br'] })
    const { encoding } = await fetchWith(app, 'br, gzip, zstd')
    expect(encoding).toBe('gzip')
  })
})

describe('compression() scope', () => {
  it('compresses JSON', async () => {
    const app = compressedApp(c => c.json(LARGE_JSON))
    const { encoding, bytes } = await fetchWith(app, 'gzip')
    expect(encoding).toBe('gzip')
    expect(JSON.parse(decoded(encoding, bytes))).toEqual(LARGE_JSON)
  })

  it.each([
    ['text/html', 'text/html; charset=utf-8'],
    ['a +json type', 'application/problem+json'],
    ['SVG', 'image/svg+xml'],
    ['JavaScript', 'text/javascript'],
  ])('compresses %s', async (_name, type) => {
    const app = compressedApp(c => c.text(LARGE_TEXT, 200, { 'content-type': type }))
    expect((await fetchWith(app, 'gzip')).encoding).toBe('gzip')
  })

  it.each([
    ['an image', 'image/png'],
    ['a zip file', 'application/zip'],
    ['an event stream', 'text/event-stream'],
    ['bytes', 'application/octet-stream'],
  ])('skips %s and sends no Vary', async (_name, type) => {
    const app = compressedApp(c => c.text(LARGE_TEXT, 200, { 'content-type': type }))
    const { encoding, response } = await fetchWith(app, 'gzip')
    expect(encoding).toBe(null)
    expect(response.headers.has('vary')).toBe(false)
  })

  it('skips a body under 1 KiB but still sends Vary', async () => {
    const app = compressedApp(c => c.text('x'.repeat(1023)))
    const { encoding, response, bytes } = await fetchWith(app, 'gzip')
    expect(encoding).toBe(null)
    expect(bytes.byteLength).toBe(1023)
    expect(varyOf(response)).toEqual(['accept-encoding'])
  })

  it('compresses a body of exactly 1 KiB', async () => {
    expect(await encodingFor(c => c.text('x'.repeat(1024)), 'gzip')).toBe('gzip')
  })

  it('measures the threshold in bytes, not characters', async () => {
    expect(await encodingFor(c => c.text('é'.repeat(512)), 'gzip')).toBe('gzip')
  })

  it('honours your threshold', async () => {
    const app = compressedApp(c => c.text('x'.repeat(200)), { threshold: 100 })
    expect((await fetchWith(app, 'gzip')).encoding).toBe('gzip')
  })

  it('sends the reply to HEAD uncompressed, with Vary: Accept-Encoding', async () => {
    const app = compressedApp(c => c.text(LARGE_TEXT))
    const { encoding, response } = await fetchWith(app, 'gzip', 'HEAD')
    expect(encoding).toBe(null)
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(LARGE_TEXT)))
    expect(response.headers.get('vary')).toBe('Accept-Encoding')
  })

  it.each([204, 206, 304])('skips the status %i', async status => {
    const app = compressedApp(c => c.text(status === 206 ? LARGE_TEXT : '', status))
    expect((await fetchWith(app, 'gzip')).encoding).toBe(null)
  })

  it('skips a response that already has Content-Encoding', async () => {
    const app = compressedApp(c => c.text(LARGE_TEXT, 200, { 'content-encoding': 'identity' }))
    expect((await fetchWith(app, 'gzip')).encoding).toBe('identity')
  })

  it.each(['no-transform', 'public, No-Transform', 'max-age=60,no-transform'])(
    'skips Cache-Control %j',
    async cacheControl => {
      const app = compressedApp(c => c.text(LARGE_TEXT, 200, { 'cache-control': cacheControl }))
      expect((await fetchWith(app, 'gzip')).encoding).toBe(null)
    },
  )

  it('skips a route that opts out', async () => {
    const app = compressedApp(c => {
      skipCompression(c)
      return c.text(LARGE_TEXT)
    })
    const { encoding, response } = await fetchWith(app, 'gzip')
    expect(encoding).toBe(null)
    expect(response.headers.has('vary')).toBe(false)
  })

  it('compresses an error reply', async () => {
    const app = createApp()
      .use(compression({ threshold: 10 }))
      .get('/', () => {
        throw new Error('broken')
      })
    const response = await app.request('/', { headers: { 'accept-encoding': 'gzip' } })
    expect(response.status).toBe(500)
    expect(response.headers.get('content-encoding')).toBe('gzip')
  })
})

describe('compression() headers', () => {
  it('appends Accept-Encoding to the Vary of the handler', async () => {
    const app = compressedApp(c => c.text(LARGE_TEXT, 200, { vary: 'Origin' }))
    expect(varyOf((await fetchWith(app, 'gzip')).response)).toEqual(['origin', 'accept-encoding'])
  })

  it('turns a strong ETag into a weak one', async () => {
    const app = compressedApp(c => c.text(LARGE_TEXT, 200, { etag: '"abc"' }))
    expect((await fetchWith(app, 'gzip')).response.headers.get('etag')).toBe('W/"abc"')
  })

  it('turns a strong ETag from the context into a weak one', async () => {
    const app = compressedApp(c => {
      c.header('ETag', '"abc"')
      return c.text(LARGE_TEXT)
    })
    expect((await fetchWith(app, 'gzip')).response.headers.get('etag')).toBe('W/"abc"')
  })

  it('keeps a weak ETag', async () => {
    const app = compressedApp(c => c.text(LARGE_TEXT, 200, { etag: 'W/"abc"' }))
    expect((await fetchWith(app, 'gzip')).response.headers.get('etag')).toBe('W/"abc"')
  })

  it('keeps a strong ETag on a response that it sends unencoded', async () => {
    const app = compressedApp(c => c.text(LARGE_TEXT, 200, { etag: '"abc"' }))
    expect((await fetchWith(app, 'identity')).response.headers.get('etag')).toBe('"abc"')
  })
})

describe('compression() streams', () => {
  it('compresses a streamed reply chunk by chunk', async () => {
    const app = compressedApp(c =>
      c.stream(
        async stream => {
          for (let index = 0; index < 50; index++) await stream.write(`chunk ${index} ${LARGE_TEXT}`)
        },
        { contentType: 'text/plain' },
      ),
    )
    const { encoding, bytes, response } = await fetchWith(app, 'br')
    const expected = Array.from({ length: 50 }, (_, index) => `chunk ${index} ${LARGE_TEXT}`).join('')
    expect(encoding).toBe('br')
    expect(response.headers.has('content-length')).toBe(false)
    expect(decoded(encoding, bytes)).toBe(expected)
  })

  it('skips a stream with a declared length under the threshold', async () => {
    const app = compressedApp(c =>
      c.stream(
        async stream => {
          await stream.write('tiny')
        },
        { contentType: 'text/plain', length: 4 },
      ),
    )
    const { encoding, response } = await fetchWith(app, 'gzip')
    expect(encoding).toBe(null)
    expect(response.headers.get('content-length')).toBe('4')
  })

  it('drops the declared length of a stream that it compresses', async () => {
    const body = 'y'.repeat(5000)
    const app = compressedApp(c =>
      c.stream(
        async stream => {
          await stream.write(body)
        },
        { contentType: 'text/plain', length: 5000 },
      ),
    )
    const { encoding, bytes, response } = await fetchWith(app, 'gzip')
    expect(encoding).toBe('gzip')
    expect(response.headers.has('content-length')).toBe(false)
    expect(decoded(encoding, bytes)).toBe(body)
  })
})

describe('compression() options', () => {
  it.each([
    ['a negative threshold', { threshold: -1 }],
    ['a fractional threshold', { threshold: 1.5 }],
    ['an unknown encoding', { encodings: ['lzma'] }],
    ['an empty list of encodings', { encodings: [] }],
    ['deflate', { encodings: ['deflate'] }],
  ])('throws INVALID_MIDDLEWARE_OPTIONS for %s', (_name, options) => {
    const build = () => compression(options as unknown as CompressionOptions)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })
})
