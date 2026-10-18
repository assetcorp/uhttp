import { describe, expect, it } from 'vitest'
import { createApp, UhttpError } from '../../../index.js'
import {
  clientAddressOf,
  hostOf,
  protocolOf,
  type TrustedProxiesOptions,
  trustedProxies,
} from '../../../middleware/trusted-proxies/index.js'
import type { TestHeaders } from '../../../testing/index.js'
import { memoryLogger } from '../../helpers/server.js'

function clientApp(options?: TrustedProxiesOptions) {
  return createApp()
    .use(trustedProxies(options))
    .get('/client', { headers: ['host'] }, c =>
      c.json({ address: clientAddressOf(c), protocol: protocolOf(c), host: hostOf(c) ?? null }),
    )
}

interface ClientFields {
  readonly address: string
  readonly protocol: string
  readonly host: string | null
}

async function clientOf(options: TrustedProxiesOptions | undefined, peer: string, headers: TestHeaders) {
  const response = await clientApp(options).request('/client', { clientAddress: peer, headers })
  return (await response.json()) as ClientFields
}

describe('trustedProxies() options', () => {
  it.each([
    ['a hop count', 1],
    ['a hop count inside the list', ['10.0.0.1', 2]],
    ['true', true],
    ['a word that is no address', ['loopback']],
    ['a range with a prefix past 32', ['10.0.0.0/33']],
    ['a range with a prefix past 128', ['::/129']],
    ['an address with a leading zero', ['010.0.0.1']],
    ['a string in place of a list', '10.0.0.1'],
  ])('throws INVALID_MIDDLEWARE_OPTIONS for %s', (_name, trust) => {
    const build = () => trustedProxies({ trust } as unknown as TrustedProxiesOptions)
    expect(build).toThrow(UhttpError)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })

  it.each([
    ['a hop count', 1],
    ['a hop count inside the list', ['10.0.0.1', 2]],
    ['true', true],
  ])('throws, for %s, the error that a client can add its own entries to X-Forwarded-For', (_name, trust) => {
    const build = () => trustedProxies({ trust } as unknown as TrustedProxiesOptions)
    expect(build).toThrow(/a client can add its own entries to X-Forwarded-For/)
  })

  it('uses the address of the peer when you pass no list of proxies', async () => {
    const client = await clientOf(undefined, '10.0.0.5', { 'x-forwarded-for': '203.0.113.9' })
    expect(client.address).toBe('10.0.0.5')
  })
})

describe('trustedProxies() client address', () => {
  const trust = { trust: ['10.0.0.0/8', '2001:db8::/32'] }

  it('uses the rightmost address that is no trusted proxy', async () => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-for': '198.51.100.1, 203.0.113.9, 10.1.1.1' })
    expect(client.address).toBe('203.0.113.9')
  })

  it('parses every line of X-Forwarded-For in order', async () => {
    const client = await clientOf(trust, '10.0.0.5', [
      ['x-forwarded-for', '198.51.100.1'],
      ['x-forwarded-for', '203.0.113.9, 10.2.2.2'],
    ])
    expect(client.address).toBe('203.0.113.9')
  })

  it('ignores a forged leftmost entry that a client added', async () => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' })
    expect(client.address).toBe('203.0.113.9')
  })

  it('stops at a garbage entry and keeps the nearest valid address', async () => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-for': '203.0.113.9, not-an-ip, 10.3.3.3' })
    expect(client.address).toBe('10.3.3.3')
  })

  it('returns the leftmost entry when every entry is a trusted proxy', async () => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-for': '10.9.9.9, 10.8.8.8' })
    expect(client.address).toBe('10.9.9.9')
  })

  it('canonicalises an IPv4-mapped address before it compares it', async () => {
    const client = await clientOf(trust, '::ffff:10.0.0.5', { 'x-forwarded-for': '203.0.113.9, ::ffff:10.4.4.4' })
    expect(client.address).toBe('203.0.113.9')
  })

  it('strips the zone ID of an IPv6 address', async () => {
    const client = await clientOf(trust, '2001:db8::5', { 'x-forwarded-for': 'fe80::1%eth0, 2001:db8::7%2' })
    expect(client.address).toBe('fe80::1')
  })

  it('writes IPv6 addresses in their short canonical form', async () => {
    const client = await clientOf(trust, '2001:db8::5', {
      'x-forwarded-for': '2001:0DB9:0000:0000:0000:0000:0000:0001',
    })
    expect(client.address).toBe('2001:db9::1')
  })

  it('parses bracketed and port-suffixed entries', async () => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-for': '[2001:db9::2]:443, 10.5.5.5:8080' })
    expect(client.address).toBe('2001:db9::2')
  })

  it('uses the peer when the peer is no trusted proxy, whatever the value of the header', async () => {
    const client = await clientOf(trust, '192.0.2.4', {
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.example',
      host: 'shop.example',
    })
    expect(client).toEqual({ address: '192.0.2.4', protocol: 'http', host: 'shop.example' })
  })

  it('ignores the RFC 7239 Forwarded header', async () => {
    const client = await clientOf(trust, '10.0.0.5', { forwarded: 'for=203.0.113.9;proto=https;host=evil.example' })
    expect(client).toEqual({ address: '10.0.0.5', protocol: 'http', host: 'localhost' })
  })

  it('treats a Unix socket peer as a proxy only with the unix entry', async () => {
    const unix = await clientOf({ trust: ['unix'] }, '', { 'x-forwarded-for': '203.0.113.9' })
    const none = await clientOf({ trust: ['10.0.0.0/8'] }, '', { 'x-forwarded-for': '203.0.113.9' })
    expect(unix.address).toBe('203.0.113.9')
    expect(none.address).toBe('')
  })
})

describe('trustedProxies() protocol and host', () => {
  const trust = { trust: ['10.0.0.5'] }

  it('uses the last X-Forwarded-Proto entry', async () => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-proto': 'http, https' })
    expect(client.protocol).toBe('https')
  })

  it.each(['ftp', 'https://', 'javascript', ''])('ignores the protocol %j', async protocol => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-proto': `https, ${protocol}` })
    expect(client.protocol).toBe('http')
  })

  it('uses the last X-Forwarded-Host entry in lowercase', async () => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-host': 'old.example, Shop.Example:8443' })
    expect(client.host).toBe('shop.example:8443')
  })

  it.each([
    'shop.example/path',
    'shop.example:99999',
    'user@shop.example',
    '[::1',
    '[not-ipv6]',
    'a b',
    `${'a'.repeat(260)}.example`,
  ])('falls back to Host for the invalid forwarded host %j', async host => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-host': host, host: 'shop.example' })
    expect(client.host).toBe('shop.example')
  })

  it('parses a bracketed IPv6 host with a port', async () => {
    const client = await clientOf(trust, '10.0.0.5', { 'x-forwarded-host': '[2001:db8::1]:8080' })
    expect(client.host).toBe('[2001:db8::1]:8080')
  })
})

describe('trustedProxies() warning', () => {
  it('logs one warning when an untrusted peer sends X-Forwarded-For', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger })
      .use(trustedProxies({ trust: ['10.0.0.5'] }))
      .get('/', c => c.text(clientAddressOf(c)))

    for (let index = 0; index < 3; index++) {
      await app.request('/', { clientAddress: '192.0.2.4', headers: { 'x-forwarded-for': '203.0.113.9' } })
    }
    await app.request('/', { clientAddress: '192.0.2.4' })

    const warnings = entries.filter(entry => entry.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.details).toEqual({ address: '192.0.2.4' })
  })

  it('logs nothing when a trusted peer sends X-Forwarded-For', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger })
      .use(trustedProxies({ trust: ['10.0.0.5'] }))
      .get('/', c => c.text(clientAddressOf(c)))

    await app.request('/', { clientAddress: '10.0.0.5', headers: { 'x-forwarded-for': '203.0.113.9' } })

    expect(entries).toEqual([])
  })
})

describe('trustedProxies() scope', () => {
  it('applies to one group alone', async () => {
    const app = createApp()
    app.group('/api', trustedProxies({ trust: ['10.0.0.5'] })).get('/client', c => c.text(clientAddressOf(c)))
    app.get('/client', { clientAddress: true }, c => c.text(clientAddressOf(c)))
    const headers = { 'x-forwarded-for': '203.0.113.9' }

    const grouped = await app.request('/api/client', { clientAddress: '10.0.0.5', headers })
    const plain = await app.request('/client', { clientAddress: '10.0.0.5', headers })

    expect(await grouped.text()).toBe('203.0.113.9')
    expect(await plain.text()).toBe('10.0.0.5')
  })
})
