import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { accessLog } from '../../middleware/access-log/index.js'
import { requestId, requestIdOf } from '../../middleware/request-id/index.js'
import { clientAddressOf, hostOf, protocolOf, trustedProxies } from '../../middleware/trusted-proxies/index.js'
import { openConnection, requestHead, send } from '../helpers/http-client.js'
import { pause, start } from '../helpers/server.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const LOG_WAIT_MS = 2_000
const POLL_MS = 10

function proxiedApp(trust: string[], lines: string[]) {
  return createApp()
    .use(trustedProxies({ trust }))
    .use(requestId())
    .use(accessLog({ write: line => lines.push(line) }))
    .get('/client', { headers: ['host'] }, c =>
      c.json({ address: clientAddressOf(c), protocol: protocolOf(c), host: hostOf(c) ?? null, id: requestIdOf(c) }),
    )
    .get('/orders/:id', c => c.text(`order ${c.req.param('id')}`))
    .get('/slow', async c => {
      await pause(300)
      return c.text('slow')
    })
}

async function lineCount(lines: string[], count: number): Promise<string[]> {
  const deadline = Date.now() + LOG_WAIT_MS
  while (lines.length < count && Date.now() < deadline) await pause(POLL_MS)
  return lines
}

describe('requests through a proxy over the network', () => {
  it('finds the client in X-Forwarded-For lines that a trusted proxy sent on the wire, and keeps the connection open', async () => {
    const server = await start(proxiedApp(['127.0.0.1', '10.0.0.0/8'], []))

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/client', [
        'X-Forwarded-For: 198.51.100.66',
        'X-Forwarded-For: 203.0.113.7, 10.0.0.2',
        'X-Forwarded-Proto: https',
        'X-Forwarded-Host: shop.example',
        'X-Request-Id: edge-4f2a',
      ]),
    )

    expect(JSON.parse(response.body.toString())).toEqual({
      address: '203.0.113.7',
      protocol: 'https',
      host: 'shop.example',
      id: 'edge-4f2a',
    })
    expect(response.headers.get('x-request-id')).toEqual(['edge-4f2a'])
    expect(connection.state).toBe('open')
  })

  it('ignores the forwarding headers and the request ID of a peer outside the list of proxies', async () => {
    const server = await start(proxiedApp(['10.0.0.0/8'], []))

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/client', [
        'X-Forwarded-For: 203.0.113.7',
        'X-Forwarded-Proto: https',
        'X-Request-Id: forged-id',
      ]),
    )
    const body: unknown = JSON.parse(response.body.toString())

    expect(body).toMatchObject({ address: '127.0.0.1', protocol: 'http', host: 'localhost' })
    const sent = response.headers.get('x-request-id')?.[0] ?? ''
    expect(sent).toMatch(UUID)
    expect(body).toMatchObject({ id: sent })
    expect(connection.state).toBe('open')
  })

  it('writes one access line for each request after its response, with the route template and the ID', async () => {
    const lines: string[] = []
    const server = await start(proxiedApp(['127.0.0.1'], lines))
    const connection = await openConnection(server.port)

    const order = await connection.exchange(
      requestHead('GET', '/orders/42?card=4111111111111111', ['X-Forwarded-For: 203.0.113.7']),
    )
    const missing = await connection.exchange(requestHead('GET', '/missing'))
    await lineCount(lines, 2)

    const orderId = order.headers.get('x-request-id')?.[0]
    const missingId = missing.headers.get('x-request-id')?.[0]
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(new RegExp(`^GET /orders/:id 200 \\d+\\.\\dms 203\\.0\\.113\\.7 ${orderId}$`))
    expect(lines[1]).toMatch(new RegExp(`^GET - 404 \\d+\\.\\dms 127\\.0\\.0\\.1 ${missingId}$`))
    expect(lines.join('\n')).not.toContain('4111')
    expect(connection.state).toBe('open')
  })

  it('writes a line with - for the status when the client disconnects before the reply, and serves the next client', async () => {
    const lines: string[] = []
    const server = await start(proxiedApp([], lines))
    const connection = await openConnection(server.port)

    void connection.write(requestHead('GET', '/slow'))
    await pause(50)
    connection.destroy()
    await lineCount(lines, 1)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^GET \/slow - \d+\.\dms 127\.0\.0\.1 [0-9a-f-]{36}$/)
    const next = await openConnection(server.port)
    const response = await next.exchange(requestHead('GET', '/orders/7'))
    expect(response.body.toString()).toBe('order 7')
    expect(next.state).toBe('open')
  })
})
