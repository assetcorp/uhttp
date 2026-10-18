import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import {
  cookies,
  deleteCookie,
  getCookie,
  getSignedCookie,
  setCookie,
  setSignedCookie,
} from '../../middleware/cookies/index.js'
import { openConnection, requestHead, send } from '../helpers/http-client.js'
import { start } from '../helpers/server.js'

const KEY = 'a signing key of more than twenty bytes'

function signed(name: string, value: string): string {
  return `${value}.${createHmac('sha256', KEY).update(`${name}=${value}`).digest('base64url')}`
}

function cookieApp() {
  return createApp()
    .use(cookies({ keys: [KEY] }))
    .get('/read', c =>
      c.json({
        theme: getCookie(c, 'theme') ?? null,
        cart: getCookie(c, 'cart') ?? null,
        session: getSignedCookie(c, 'session') ?? null,
      }),
    )
    .post('/sign-in', c => {
      setSignedCookie(c, 'session', 'user-42')
      setCookie(c, 'theme', 'dark', { httpOnly: false, maxAge: 3600 })
      deleteCookie(c, 'cart')
      return c.text('signed in')
    })
}

describe('cookies over the network', () => {
  it('parses the cookies of every Cookie line that the client sent, and keeps the connection open', async () => {
    const server = await start(cookieApp())

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/read', [
        'Cookie: theme=light',
        `Cookie: cart="3 items"; session=${signed('session', 'user-42')}`,
      ]),
    )

    expect(JSON.parse(response.body.toString())).toEqual({ theme: 'light', cart: '3 items', session: 'user-42' })
    expect(connection.state).toBe('open')
  })

  it('sends one Set-Cookie line for each cookie, with a signature that HMAC-SHA256 over the name and value matches', async () => {
    const server = await start(cookieApp())
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('POST', '/sign-in', ['Content-Length: 0']))

    expect(response.headers.get('set-cookie')).toEqual([
      `session=${signed('session', 'user-42')}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      'theme=dark; Max-Age=3600; Path=/; Secure; SameSite=Lax',
      'cart=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    ])
    expect(connection.state).toBe('open')
  })

  it('treats a session cookie with a changed value or a forged signature as absent', async () => {
    const server = await start(cookieApp())
    const connection = await openConnection(server.port)
    const genuine = signed('session', 'user-42')

    const changed = await connection.exchange(
      requestHead('GET', '/read', [`Cookie: session=${genuine.replace('user-42', 'user-1')}`]),
    )
    const forged = await connection.exchange(requestHead('GET', '/read', [`Cookie: session=user-1.${'A'.repeat(43)}`]))
    const renamed = await connection.exchange(
      requestHead('GET', '/read', [`Cookie: theme=x; session=${signed('theme', 'user-42')}`]),
    )

    for (const response of [changed, forged, renamed]) {
      expect(JSON.parse(response.body.toString())).toMatchObject({ session: null })
    }
    expect(connection.state).toBe('open')
  })
})
