import { describe, expect, it } from 'vitest'
import { createApp, serve } from '../../index.js'
import { nonceOf, secureHeaders } from '../../middleware/secure-headers/index.js'
import { certificateDirectory, writeCertificate } from '../helpers/certificates.js'
import { openConnection, requestHead } from '../helpers/http-client.js'
import { start, track } from '../helpers/server.js'
import { openTlsConnection } from '../helpers/tls-client.js'

const HSTS = 'max-age=15552000; includeSubDomains'
const NONCE = /^'nonce-([A-Za-z0-9+/]{22}==)'$/

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
