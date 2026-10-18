import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Context, createApp, type Logger, UhttpError } from '../../../index.js'
import {
  type CookieOptions,
  type CookiesOptions,
  cookies,
  deleteCookie,
  getCookie,
  getSignedCookie,
  setCookie,
  setSignedCookie,
} from '../../../middleware/cookies/index.js'
import type { TestHeaders } from '../../../testing/index.js'
import { type LogEntry, memoryLogger } from '../../helpers/server.js'

const KEY = 'k'.repeat(32)
const OLD_KEY = 'o'.repeat(24)

function signature(key: string, name: string, value: string): string {
  return createHmac('sha256', key).update(`${name}=${value}`).digest('base64url')
}

function loggedCode(entries: readonly LogEntry[]): string | undefined {
  const error = entries.find(entry => entry.level === 'error')?.details.err
  return error instanceof UhttpError ? error.code : undefined
}

function readApp(options?: CookiesOptions, logger?: Logger) {
  return createApp(logger === undefined ? {} : { logger })
    .use(cookies(options))
    .get('/read/:name', c => c.json({ value: getCookie(c, c.req.param('name') ?? '') ?? null }))
    .get('/signed/:name', c => c.json({ value: getSignedCookie(c, c.req.param('name') ?? '') ?? null }))
}

async function cookieValue(app: ReturnType<typeof readApp>, path: string, headers: TestHeaders) {
  const response = await app.request(path, { headers })
  const { value } = (await response.json()) as { value: string | null }
  return value
}

function setApp(set: (c: Context) => void, logger?: Logger) {
  return createApp(logger === undefined ? {} : { logger })
    .use(cookies({ keys: [KEY] }))
    .get('/set', c => {
      set(c)
      return c.text('set')
    })
}

describe('cookies() reading', () => {
  it('parses each pair, trims spaces, and strips quotes', async () => {
    const app = readApp()
    const headers = { cookie: 'theme=dark;  lang = en ; quoted="a b"' }
    expect(await cookieValue(app, '/read/theme', headers)).toBe('dark')
    expect(await cookieValue(app, '/read/lang', headers)).toBe('en')
    expect(await cookieValue(app, '/read/quoted', headers)).toBe('a b')
    expect(await cookieValue(app, '/read/missing', headers)).toBe(null)
  })

  it('parses every Cookie line', async () => {
    const app = readApp()
    const headers: TestHeaders = [
      ['cookie', 'theme=dark'],
      ['cookie', 'lang=en'],
    ]
    expect(await cookieValue(app, '/read/theme', headers)).toBe('dark')
    expect(await cookieValue(app, '/read/lang', headers)).toBe('en')
  })

  it('keeps the first of two cookies with the same name', async () => {
    expect(await cookieValue(readApp(), '/read/id', { cookie: 'id=first; id=second' })).toBe('first')
  })

  it('keeps an equals sign inside the value', async () => {
    expect(await cookieValue(readApp(), '/read/token', { cookie: 'token=a=b==' })).toBe('a=b==')
  })

  it('skips pairs without a name or an equals sign', async () => {
    const app = readApp()
    const headers = { cookie: '=orphan; flag; ok=1' }
    expect(await cookieValue(app, '/read/ok', headers)).toBe('1')
    expect(await cookieValue(app, '/read/flag', headers)).toBe(null)
  })

  it('treats __proto__ as an ordinary name', async () => {
    expect(await cookieValue(readApp(), '/read/__proto__', { cookie: '__proto__=x' })).toBe('x')
    expect(await cookieValue(readApp(), '/read/constructor', { cookie: 'a=b' })).toBe(null)
  })

  it('parses a large header with many pairs', async () => {
    const cookie = Array.from({ length: 400 }, (_, index) => `c${index}=${index}`).join('; ')
    expect(await cookieValue(readApp(), '/read/c399', { cookie })).toBe('399')
  })

  it('parses lazily, so the package never parses a malformed header on a route that asks for no cookie', async () => {
    const app = createApp()
      .use(cookies())
      .get('/', c => c.text('home'))
    const response = await app.request('/', { headers: { cookie: ';;;===;;' } })
    expect(await response.text()).toBe('home')
  })
})

describe('cookies() signing', () => {
  it('signs with HMAC-SHA-256 over the name and the value', async () => {
    const app = setApp(c => setSignedCookie(c, 'session', 'user-42'))
    const response = await app.request('/set')
    const line = response.headers.getSetCookie()[0] ?? ''
    expect(line.startsWith(`session=user-42.${signature(KEY, 'session', 'user-42')};`)).toBe(true)
  })

  it('verifies a signature from the first key', async () => {
    const cookie = `session=user-42.${signature(KEY, 'session', 'user-42')}`
    expect(await cookieValue(readApp({ keys: [KEY, OLD_KEY] }), '/signed/session', { cookie })).toBe('user-42')
  })

  it('verifies a signature from an older key', async () => {
    const cookie = `session=user-42.${signature(OLD_KEY, 'session', 'user-42')}`
    expect(await cookieValue(readApp({ keys: [KEY, OLD_KEY] }), '/signed/session', { cookie })).toBe('user-42')
  })

  it('verifies a signed value that contains dots', async () => {
    const cookie = `v=a.b.c.${signature(KEY, 'v', 'a.b.c')}`
    expect(await cookieValue(readApp({ keys: [KEY] }), '/signed/v', { cookie })).toBe('a.b.c')
  })

  it.each([
    ['a changed value', `session=user-43.${signature(KEY, 'session', 'user-42')}`],
    ['a signature for another name', `session=user-42.${signature(KEY, 'other', 'user-42')}`],
    ['a signature from an unknown key', `session=user-42.${signature('u'.repeat(32), 'session', 'user-42')}`],
    ['a short signature', `session=user-42.${signature(KEY, 'session', 'user-42').slice(0, 20)}`],
    ['a long signature', `session=user-42.${signature(KEY, 'session', 'user-42')}AAAA`],
    ['no signature', 'session=user-42'],
    ['an empty signature', 'session=user-42.'],
    ['garbage', 'session=....'],
  ])('refuses %s', async (_name, cookie) => {
    expect(await cookieValue(readApp({ keys: [KEY] }), '/signed/session', { cookie })).toBe(null)
  })

  it('replies 500 INVALID_COOKIE when your code calls a signed helper without keys', async () => {
    const { entries, logger } = memoryLogger()
    const response = await readApp(undefined, logger).request('/signed/session', { headers: { cookie: 'session=a.b' } })
    expect(response.status).toBe(500)
    expect(loggedCode(entries)).toBe('INVALID_COOKIE')
  })
})

describe('cookies() writing', () => {
  it('defaults new cookies to HttpOnly, Secure, SameSite=Lax, and Path=/', async () => {
    const response = await setApp(c => setCookie(c, 'theme', 'dark')).request('/set')
    expect(response.headers.getSetCookie()).toEqual(['theme=dark; Path=/; HttpOnly; Secure; SameSite=Lax'])
  })

  it('writes every attribute that you pass', async () => {
    const expires = new Date(Date.UTC(2030, 0, 2, 3, 4, 5))
    const response = await setApp(c =>
      setCookie(c, 'id', 'abc', {
        domain: 'shop.example',
        path: '/account',
        maxAge: 3600,
        expires,
        httpOnly: false,
        sameSite: 'Strict',
        partitioned: true,
      }),
    ).request('/set')
    expect(response.headers.getSetCookie()).toEqual([
      'id=abc; Max-Age=3600; Domain=shop.example; Path=/account; Expires=Wed, 02 Jan 2030 03:04:05 GMT; Secure; SameSite=Strict; Partitioned',
    ])
  })

  it('switches Secure off when you ask for it for plain-HTTP localhost', async () => {
    const response = await setApp(c => setCookie(c, 'dev', '1', { secure: false })).request('/set')
    expect(response.headers.getSetCookie()).toEqual(['dev=1; Path=/; HttpOnly; SameSite=Lax'])
  })

  it('sends one line for each cookie', async () => {
    const response = await setApp(c => {
      setCookie(c, 'a', '1')
      setCookie(c, 'b', '2')
    }).request('/set')
    expect(response.headers.getSetCookie()).toHaveLength(2)
  })

  it('deletes a cookie with an empty value, Max-Age=0, and an expiry in the past', async () => {
    const response = await setApp(c => deleteCookie(c, 'theme', { path: '/app' })).request('/set')
    expect(response.headers.getSetCookie()).toEqual([
      'theme=; Max-Age=0; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    ])
  })

  it('sets a cookie whose name and value come to exactly 4,096 bytes', async () => {
    const response = await setApp(c => setCookie(c, 'n', 'v'.repeat(4095))).request('/set')
    expect(response.status).toBe(200)
  })

  it.each<[string, (c: Context) => void]>([
    ['a name and a value above 4,096 bytes', c => setCookie(c, 'n', 'v'.repeat(4096))],
    ['a multibyte value above 4,096 bytes', c => setCookie(c, 'n', 'é'.repeat(2048))],
    ['a value with a semicolon', c => setCookie(c, 'n', 'a;b')],
    ['a value with CR', c => setCookie(c, 'n', 'a\rb')],
    ['a value with LF', c => setCookie(c, 'n', 'a\nb')],
    ['a name with a space', c => setCookie(c, 'my name', 'v')],
    ['a name with an equals sign', c => setCookie(c, 'a=b', 'v')],
    ['an empty name', c => setCookie(c, '', 'v')],
    ['a path with a semicolon', c => setCookie(c, 'n', 'v', { path: '/; Domain=evil.example' })],
    ['a domain with LF', c => setCookie(c, 'n', 'v', { domain: 'shop.example\nx' })],
    ['SameSite=None without Secure', c => setCookie(c, 'n', 'v', { sameSite: 'None', secure: false })],
    ['Partitioned without Secure', c => setCookie(c, 'n', 'v', { partitioned: true, secure: false })],
    ['a fractional Max-Age', c => setCookie(c, 'n', 'v', { maxAge: 1.5 })],
    ['a Max-Age past 400 days', c => setCookie(c, 'n', 'v', { maxAge: 34560001 })],
    ['an invalid date', c => setCookie(c, 'n', 'v', { expires: new Date(Number.NaN) })],
    ['__Secure- without Secure', c => setCookie(c, '__Secure-id', 'v', { secure: false })],
    ['__secure- in lowercase without Secure', c => setCookie(c, '__secure-id', 'v', { secure: false })],
    ['__Host- with a domain', c => setCookie(c, '__Host-id', 'v', { domain: 'shop.example' })],
    ['__HOST- with a path other than /', c => setCookie(c, '__HOST-id', 'v', { path: '/app' })],
    ['__Host- without Secure', c => setCookie(c, '__Host-id', 'v', { secure: false })],
  ])('answers 500 INVALID_COOKIE for %s', async (_name, set) => {
    const { entries, logger } = memoryLogger()
    const response = await setApp(set, logger).request('/set')
    expect(response.status).toBe(500)
    expect(loggedCode(entries)).toBe('INVALID_COOKIE')
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it('sets SameSite=None with Secure for an OIDC form_post callback', async () => {
    const response = await setApp(c => setCookie(c, 'state', 'xyz', { sameSite: 'None' })).request('/set')
    expect(response.headers.getSetCookie()).toEqual(['state=xyz; Path=/; HttpOnly; Secure; SameSite=None'])
  })

  it('sets a __Host- cookie with the defaults', async () => {
    const response = await setApp(c => setCookie(c, '__Host-id', 'v')).request('/set')
    expect(response.headers.getSetCookie()).toEqual(['__Host-id=v; Path=/; HttpOnly; Secure; SameSite=Lax'])
  })
})

describe('cookies() options', () => {
  it.each([
    ['a key shorter than 20 bytes', { keys: ['short-key-19-bytes!'] }],
    ['an empty key list', { keys: [] }],
    ['a key that is a number', { keys: [123456789012345] }],
    ['keys that are no list', { keys: KEY }],
  ])('throws INVALID_MIDDLEWARE_OPTIONS for %s', (_name, options) => {
    const build = () => cookies(options as unknown as CookiesOptions)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })

  it('builds the middleware with a key of 20 bytes as a string or as bytes', () => {
    expect(() => cookies({ keys: ['k'.repeat(20), new Uint8Array(20)] })).not.toThrow()
  })

  it('types the attributes of a cookie', () => {
    const options: CookieOptions = { sameSite: 'Lax', maxAge: 60 }
    expect(options.sameSite).toBe('Lax')
  })
})
