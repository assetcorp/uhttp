import { describe, expect, it } from 'vitest'
import { createApp, serve } from '../../index.js'
import { nonceOf, secureHeaders } from '../../middleware/secure-headers/index.js'
import { certificateDirectory, writeCertificate } from '../helpers/certificates.js'
import { openConnection, requestHead, requestWithBody } from '../helpers/http-client.js'
import { start, track } from '../helpers/server.js'
import { openTlsConnection } from '../helpers/tls-client.js'

const HSTS = 'max-age=15552000; includeSubDomains'
const NONCE = /^'nonce-([A-Za-z0-9+/]{22}==)'$/

const WEB_HEADERS: Record<string, string> = {
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
}

function expectWebHeaders(headers: Map<string, string[]>, changed: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries({ ...WEB_HEADERS, ...changed })) {
    expect(headers.get(name), name).toEqual([value])
  }
}

function shopApp() {
  return createApp()
    .use(secureHeaders())
    .get('/text', c => c.text('Hello, shop!'))
    .get('/json', c => c.json({ basket: 3 }))
    .get('/frame', c => {
      c.header('referrer-policy', 'strict-origin')
      return c.text('framed', 200, { 'x-frame-options': 'DENY' })
    })
    .get('/broken', () => {
      throw new Error('The stock service is down.')
    })
    .post('/basket', async c => c.json({ bytes: (await c.req.body.bytes()).byteLength }))
}

function securedApp() {
  return createApp()
    .use(secureHeaders({ contentSecurityPolicy: nonce => `script-src 'nonce-${nonce}'` }))
    .get('/page', c => c.text(`<script nonce="${nonceOf(c)}">start()</script>`))
}

function nonceIn(policy: string | undefined): string {
  const source = policy?.replace(/^script-src /, '') ?? ''
  const match = NONCE.exec(source)
  if (match === null) throw new Error(`The policy holds no nonce: ${policy}`)
  return match[1] ?? ''
}

describe('security headers over the network', () => {
  it('sends Strict-Transport-Security over TLS, on a page and on a 404, and keeps the connection open', async () => {
    const tls = writeCertificate(certificateDirectory(), 'shop', 'shop.test')
    const server = track(await serve({ app: securedApp(), port: 0, host: '127.0.0.1', tls }))
    const connection = await openTlsConnection(server.port, 'shop.test')

    const page = await connection.http.exchange(requestHead('GET', '/page'))
    const missing = await connection.http.exchange(requestHead('GET', '/missing'))

    expect(page.headers.get('strict-transport-security')).toEqual([HSTS])
    expect(missing.status).toBe(404)
    expect(missing.headers.get('strict-transport-security')).toEqual([HSTS])
    expect(missing.headers.get('x-content-type-options')).toEqual(['nosniff'])
    expect(connection.http.state).toBe('open')
  })

  it('leaves out Strict-Transport-Security over plain HTTP, and sends the other headers', async () => {
    const server = await start(securedApp())
    const connection = await openConnection(server.port)

    const page = await connection.exchange(requestHead('GET', '/page'))

    expect(page.headers.has('strict-transport-security')).toBe(false)
    expect(page.headers.get('x-frame-options')).toEqual(['SAMEORIGIN'])
    expect(page.headers.get('referrer-policy')).toEqual(['no-referrer'])
    expect(connection.state).toBe('open')
  })

  it('sends each header once on every pipelined text and JSON reply, with the right type and body', async () => {
    const server = await start(shopApp())
    const connection = await openConnection(server.port)

    void connection.write(requestHead('GET', '/text') + requestHead('GET', '/json') + requestHead('GET', '/text'))
    const first = await connection.response()
    const second = await connection.response()
    const third = await connection.response()

    for (const response of [first, second, third]) {
      expect(response.status).toBe(200)
      expectWebHeaders(response.headers)
    }
    expect(first.headers.get('content-type')).toEqual(['text/plain; charset=UTF-8'])
    expect(second.headers.get('content-type')).toEqual(['application/json'])
    expect(first.body.toString()).toBe('Hello, shop!')
    expect(JSON.parse(second.body.toString())).toEqual({ basket: 3 })
    expect(third.body.toString()).toBe('Hello, shop!')
    expect(await connection.finish()).toBe('closed')
  })

  it('sends the value that the handler set in place of the preset, on one line each', async () => {
    const server = await start(shopApp())
    const connection = await openConnection(server.port)

    const framed = await connection.exchange(requestHead('GET', '/frame'))

    expectWebHeaders(framed.headers, { 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin' })
    expect(framed.body.toString()).toBe('framed')
    expect(connection.state).toBe('open')
  })

  it('sends the headers on a HEAD reply, a 404, a 500, and a reply to a POST with a body', async () => {
    const server = await start(shopApp())
    const connection = await openConnection(server.port)

    const head = await connection.exchange(requestHead('HEAD', '/text'), { method: 'HEAD' })
    const missing = await connection.exchange(requestHead('GET', '/missing'))
    const broken = await connection.exchange(requestHead('GET', '/broken'))
    const basket = await connection.exchange(
      requestWithBody('POST', '/basket', ['Content-Type: application/octet-stream'], Buffer.alloc(4096, 0x61)),
    )

    expect([head.status, missing.status, broken.status, basket.status]).toEqual([200, 404, 500, 200])
    expect(head.headers.get('content-length')).toEqual(['12'])
    expect(head.body).toHaveLength(0)
    for (const response of [head, missing, broken, basket]) expectWebHeaders(response.headers)
    expect(JSON.parse(basket.body.toString())).toEqual({ bytes: 4096 })
    expect(connection.state).toBe('open')
  })

  it('sends each header once on the 503 of a handler that passes its time limit, and then closes the connection', async () => {
    const app = createApp({ timeoutMs: 50 })
      .use(secureHeaders())
      .get('/report', async c => {
        await new Promise(resolve => setTimeout(resolve, 300))
        return c.text('late report')
      })
    const server = await start(app)
    const connection = await openConnection(server.port)

    const response = await connection.exchange(requestHead('GET', '/report'))

    expect(response.status).toBe(503)
    expect(response.headers.get('connection')).toEqual(['close'])
    expectWebHeaders(response.headers)
    expect(JSON.parse(response.body.toString())).toEqual({
      error: { code: 'HANDLER_TIMEOUT', message: expect.any(String) },
    })
    expect(await connection.waitForClose()).toBe('closed')
  })

  it('sends a fresh nonce on each request, which matches the nonce in the page', async () => {
    const server = await start(securedApp())
    const connection = await openConnection(server.port)

    const first = await connection.exchange(requestHead('GET', '/page'))
    const second = await connection.exchange(requestHead('GET', '/page'))
    const firstNonce = nonceIn(first.headers.get('content-security-policy')?.[0])
    const secondNonce = nonceIn(second.headers.get('content-security-policy')?.[0])

    expect(first.body.toString()).toBe(`<script nonce="${firstNonce}">start()</script>`)
    expect(second.body.toString()).toBe(`<script nonce="${secondNonce}">start()</script>`)
    expect(Buffer.from(firstNonce, 'base64')).toHaveLength(16)
    expect(firstNonce).not.toBe(secondNonce)
    expect(connection.state).toBe('open')
  })
})
