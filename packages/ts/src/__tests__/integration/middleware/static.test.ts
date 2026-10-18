import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'
import { type ServeStaticOptions, serveStatic } from '../../../middleware/static/index.js'
import type { TestRequestInit } from '../../../testing/index.js'

const HELLO = 'Hello, static world!'
const MODIFIED = new Date(Date.UTC(2026, 0, 15, 12, 30, 45, 250))

let base = ''
let root = ''

function file(path: string, body: string | Uint8Array): void {
  writeFileSync(join(root, path), body)
  utimesSync(join(root, path), MODIFIED, MODIFIED)
}

function tagOf(path: string): string {
  const stats = statSync(join(root, path))
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'uhttp-static-'))
  root = join(base, 'public')
  mkdirSync(root)
  mkdirSync(join(root, 'docs'))
  mkdirSync(join(root, 'nested'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, '.well-known'))
  mkdirSync(join(root, 'nested', '.hidden'))
  file('hello.txt', HELLO)
  file('index.html', '<h1>home</h1>')
  file('docs/index.html', '<h1>docs</h1>')
  file('app.js', 'console.log(1)')
  file('style.css', 'body{}')
  file('data.json', '{"a":1}')
  file('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  file('archive.unknownext', 'bytes')
  file('café.txt', 'accent')
  file('a b.txt', 'space')
  file('.env', 'SECRET=1')
  file('.git/config', '[core]')
  file('.well-known/security.txt', 'Contact: mailto:security@shop.example')
  file('nested/.hidden/file.txt', 'hidden')
  file('nested/readme.txt', 'readme')
  writeFileSync(join(base, 'secret.txt'), 'outside')
  symlinkSync(join(base, 'secret.txt'), join(root, 'escape.txt'))
  symlinkSync(join(root, 'hello.txt'), join(root, 'alias.txt'))
  symlinkSync(base, join(root, 'up'))
  symlinkSync(join(root, 'nested'), join(root, 'linked'))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

function staticApp(options: Omit<ServeStaticOptions, 'root'> = {}) {
  return createApp()
    .use(serveStatic({ root, ...options }))
    .get('/api/items', c => c.json(['tea']))
}

async function get(path: string, init: TestRequestInit = {}, options: Omit<ServeStaticOptions, 'root'> = {}) {
  const response = await staticApp(options).request(path, init)
  return { response, body: await response.text() }
}

describe('serveStatic() files', () => {
  it('serves a file with its type, caching headers, and validators', async () => {
    const { response, body } = await get('/hello.txt')
    expect(response.status).toBe(200)
    expect(body).toBe(HELLO)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('content-length')).toBe(String(HELLO.length))
    expect(response.headers.get('cache-control')).toBe('public, max-age=0')
    expect(response.headers.get('etag')).toBe(tagOf('hello.txt'))
    expect(response.headers.get('last-modified')).toBe('Thu, 15 Jan 2026 12:30:45 GMT')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
  })

  it.each([
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'text/css; charset=utf-8'],
    ['/data.json', 'application/json; charset=utf-8'],
    ['/logo.png', 'image/png'],
    ['/index.html', 'text/html; charset=utf-8'],
    ['/archive.unknownext', 'application/octet-stream'],
  ])('sends %s as %s', async (path, type) => {
    const { response } = await get(path)
    expect(response.headers.get('content-type')).toBe(type)
  })

  it('sends the Cache-Control that you pass', async () => {
    const { response } = await get('/hello.txt', {}, { cacheControl: 'public, max-age=31536000, immutable' })
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('replies to HEAD with the headers and no body', async () => {
    const { response, body } = await get('/hello.txt', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(body).toBe('')
    expect(response.headers.get('content-length')).toBe(String(HELLO.length))
  })

  it('passes a request for a missing file on to the routes', async () => {
    const missing = await get('/missing.txt')
    const route = await get('/api/items')
    expect(missing.response.status).toBe(404)
    expect(route.body).toBe('["tea"]')
  })

  it('passes a method other than GET and HEAD on to the routes', async () => {
    const { response } = await get('/hello.txt', { method: 'POST', body: 'x' })
    expect(response.status).toBe(404)
  })

  it('serves the index file of a directory with a trailing slash', async () => {
    expect((await get('/')).body).toBe('<h1>home</h1>')
    expect((await get('/docs/')).body).toBe('<h1>docs</h1>')
  })

  it('passes a directory without a trailing slash on to the routes', async () => {
    expect((await get('/docs')).response.status).toBe(404)
  })

  it('serves no index when you switch it off', async () => {
    expect((await get('/docs/', {}, { index: false })).response.status).toBe(404)
  })

  it('serves files under a prefix', async () => {
    const app = createApp().use(serveStatic({ root, prefix: '/assets' }))
    expect(await (await app.request('/assets/hello.txt')).text()).toBe(HELLO)
    expect((await app.request('/hello.txt')).status).toBe(404)
    expect((await app.request('/assetsx/hello.txt')).status).toBe(404)
  })
})

describe('serveStatic() paths', () => {
  it('serves a percent-encoded name in its canonical form', async () => {
    expect((await get('/caf%C3%A9.txt')).body).toBe('accent')
    expect((await get('/a%20b.txt')).body).toBe('space')
  })

  it.each([
    ['lowercase hex', '/caf%c3%a9.txt'],
    ['an encoded unreserved character', '/hello%2Etxt'],
    ['an encoded letter', '/%68ello.txt'],
    ['a dot-dot segment', '/docs/../hello.txt'],
    ['an encoded dot-dot segment', '/docs/%2E%2E/hello.txt'],
    ['an encoded slash', '/docs%2Findex.html'],
    ['an encoded backslash', '/docs%5Cindex.html'],
    ['an encoded NUL', '/hello.txt%00'],
    ['a double slash', '//hello.txt'],
    ['a dot segment', '/./hello.txt'],
    ['a broken percent sequence', '/hello%E2.txt'],
    ['an overlong UTF-8 sequence', '/%C0%AE%C0%AE/secret.txt'],
  ])('answers 404 for %s', async (_name, path) => {
    const { response } = await get(path)
    expect(response.status).toBe(404)
  })

  it('replies 404 for a case that differs from the name on disk', async () => {
    expect((await get('/HELLO.txt')).response.status).toBe(404)
    expect((await get('/NESTED/readme.txt')).response.status).toBe(404)
  })

  it('serves the target of a symlink inside the folder', async () => {
    expect((await get('/alias.txt')).body).toBe(HELLO)
    expect((await get('/linked/readme.txt')).body).toBe('readme')
  })

  it('serves no file through a symlink whose target is outside the folder', async () => {
    expect((await get('/escape.txt')).response.status).toBe(404)
    expect((await get('/up/secret.txt')).response.status).toBe(404)
  })

  it('skips hidden files and folders in every segment', async () => {
    expect((await get('/.env')).response.status).toBe(404)
    expect((await get('/.git/config')).response.status).toBe(404)
    expect((await get('/nested/.hidden/file.txt')).response.status).toBe(404)
    expect((await get('/%2Eenv')).response.status).toBe(404)
  })

  it('serves .well-known', async () => {
    expect((await get('/.well-known/security.txt')).body).toBe('Contact: mailto:security@shop.example')
  })

  it('serves hidden files when you allow them', async () => {
    expect((await get('/.env', {}, { dotfiles: 'allow' })).body).toBe('SECRET=1')
  })
})

describe('serveStatic() conditional requests', () => {
  it('replies to a matching If-None-Match with 304 and no body', async () => {
    const { response, body } = await get('/hello.txt', { headers: { 'if-none-match': tagOf('hello.txt') } })
    expect(response.status).toBe(304)
    expect(body).toBe('')
    expect(response.headers.get('etag')).toBe(tagOf('hello.txt'))
  })

  it.each([
    ['a list', () => `"other", ${tagOf('hello.txt')}`],
    ['the strong form of the weak tag', () => tagOf('hello.txt').slice(2)],
    ['*', () => '*'],
  ])('matches If-None-Match with %s', async (_name, header) => {
    expect((await get('/hello.txt', { headers: { 'if-none-match': header() } })).response.status).toBe(304)
  })

  it('evaluates If-None-Match before If-Modified-Since', async () => {
    const { response } = await get('/hello.txt', {
      headers: { 'if-none-match': '"other"', 'if-modified-since': 'Fri, 01 Jan 2100 00:00:00 GMT' },
    })
    expect(response.status).toBe(200)
  })

  it('replies 304 to If-Modified-Since at or after the change', async () => {
    const at = await get('/hello.txt', { headers: { 'if-modified-since': 'Thu, 15 Jan 2026 12:30:45 GMT' } })
    const before = await get('/hello.txt', { headers: { 'if-modified-since': 'Thu, 15 Jan 2026 12:30:44 GMT' } })
    const garbage = await get('/hello.txt', { headers: { 'if-modified-since': 'yesterday' } })
    expect(at.response.status).toBe(304)
    expect(before.response.status).toBe(200)
    expect(garbage.response.status).toBe(200)
  })
})

describe('serveStatic() ranges', () => {
  it.each([
    ['bytes=0-4', 'Hello', 'bytes 0-4/20'],
    ['bytes=-6', 'world!', 'bytes 14-19/20'],
    ['bytes=7-', 'static world!', 'bytes 7-19/20'],
    ['bytes=14-9999', 'world!', 'bytes 14-19/20'],
    ['bytes=19-19', '!', 'bytes 19-19/20'],
  ])('answers %s with 206', async (range, body, contentRange) => {
    const result = await get('/hello.txt', { headers: { range } })
    expect(result.response.status).toBe(206)
    expect(result.body).toBe(body)
    expect(result.response.headers.get('content-range')).toBe(contentRange)
    expect(result.response.headers.get('content-length')).toBe(String(body.length))
  })

  it.each(['bytes=20-', 'bytes=99999-100000', 'bytes=-0'])('answers %s with 416', async range => {
    const { response } = await get('/hello.txt', { headers: { range } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */20')
  })

  it.each(['bytes=0-1,3-4', 'bytes=abc', 'items=0-4', 'bytes=5-2', 'bytes=--1', 'bytes=1e1-'])(
    'sends the whole file for %j',
    async range => {
      const result = await get('/hello.txt', { headers: { range } })
      expect(result.response.status).toBe(200)
      expect(result.body).toBe(HELLO)
    },
  )

  it('honours If-Range with the exact Last-Modified date', async () => {
    const result = await get('/hello.txt', {
      headers: { range: 'bytes=0-4', 'if-range': 'Thu, 15 Jan 2026 12:30:45 GMT' },
    })
    expect(result.response.status).toBe(206)
  })

  it.each([
    ['another date', 'Thu, 15 Jan 2026 12:30:44 GMT'],
    ['the weak tag', () => tagOf('hello.txt')],
    ['a date in another format', 'Thursday, 15-Jan-26 12:30:45 GMT'],
  ])('sends the whole file for If-Range with %s', async (_name, value) => {
    const ifRange = typeof value === 'function' ? value() : value
    const result = await get('/hello.txt', { headers: { range: 'bytes=0-4', 'if-range': ifRange } })
    expect(result.response.status).toBe(200)
    expect(result.body).toBe(HELLO)
  })

  it('ignores Range on HEAD', async () => {
    const { response } = await get('/hello.txt', { method: 'HEAD', headers: { range: 'bytes=0-4' } })
    expect(response.status).toBe(200)
  })
})

describe('serveStatic() options', () => {
  it.each([
    ['a missing root', {}],
    ['a root that does not exist', { root: join(tmpdir(), 'uhttp-static-missing-folder') }],
    ['a root that is a file', { root: '__FILE__' }],
    ['a prefix without a leading slash', { prefix: 'assets' }],
    ['a prefix with a trailing slash', { prefix: '/assets/' }],
    ['an unknown dotfiles policy', { dotfiles: 'deny-all' }],
    ['a Cache-Control with a line break', { cacheControl: 'public\r\nx: y' }],
    ['an index with a slash', { index: '../index.html' }],
  ])('throws INVALID_MIDDLEWARE_OPTIONS for %s', (_name, options) => {
    const resolved = 'root' in options && options.root === '__FILE__' ? { root: join(root, 'hello.txt') } : options
    const withRoot = 'root' in resolved || _name === 'a missing root' ? resolved : { root, ...resolved }
    const build = () => serveStatic(withRoot as unknown as ServeStaticOptions)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })
})
