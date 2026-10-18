import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { cors } from '../../middleware/cors/index.js'
import { csrf } from '../../middleware/csrf/index.js'
import { chunkedRequest, openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import { errorBody, expectClosedAfterReply, expectHello } from '../helpers/replies.js'
import { start } from '../helpers/server.js'

const SHOP = 'https://shop.example'
const ATTACKER = 'https://attacker.example'
const CSRF_REJECTED = errorBody(
  'CSRF_REJECTED',
  'The package rejected this request, because the app allows neither the value of its Sec-Fetch-Site header nor the value of its Origin header.',
)
const FORM_LINES = [
  'Content-Type: application/x-www-form-urlencoded',
  'Sec-Fetch-Site: cross-site',
  `Origin: ${ATTACKER}`,
]

function corsApp() {
  return createApp()
    .use(cors({ origin: [SHOP], credentials: true }))
    .post('/orders', c => c.json({ placed: true }))
    .get('/hello', c => c.text('Hello'))
}

function csrfApp(handled: string[]) {
  return createApp()
    .use(csrf())
    .post('/transfer', async c => {
      handled.push(Buffer.from(await c.req.body.bytes()).toString())
      return c.text('moved')
    })
    .get('/hello', c => c.text('Hello'))
}

describe('cross-origin requests over the network', () => {
  it('replies 204 to a preflight from an allowed origin to a path with no route, and keeps the connection open', async () => {
    const server = await start(corsApp())

    const { connection, response } = await send(
      server.port,
      requestHead('OPTIONS', '/no-route-here', [
        `Origin: ${SHOP}`,
        'Access-Control-Request-Method: PUT',
        'Access-Control-Request-Headers: content-type, x-cart-id',
      ]),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toEqual([SHOP])
    expect(response.headers.get('access-control-allow-credentials')).toEqual(['true'])
    expect(response.headers.get('access-control-allow-methods')).toEqual(['GET, HEAD, PUT, POST, DELETE, PATCH'])
    expect(response.headers.get('access-control-allow-headers')).toEqual(['content-type, x-cart-id'])
    expect(response.headers.get('access-control-max-age')).toEqual(['600'])
    expect(response.headers.get('vary')).toEqual(['Origin', 'Access-Control-Request-Headers'])
    expect(response.body.length).toBe(0)
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('sends no CORS header to a preflight from another origin, and passes it to the routes', async () => {
    const server = await start(corsApp())

    const { connection, response } = await send(
      server.port,
      requestHead('OPTIONS', '/orders', [`Origin: ${ATTACKER}`, 'Access-Control-Request-Method: POST']),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('allow')).toEqual(['POST, OPTIONS'])
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(response.headers.get('vary')).toEqual(['Origin'])
    expect(connection.state).toBe('open')
  })

  it('passes a preflight from another origin to the routes under one fixed origin, and still sends that origin on every GET', async () => {
    const app = createApp()
      .use(cors({ origin: SHOP, credentials: true }))
      .post('/orders', c => c.json({ placed: true }))
      .get('/hello', c => c.text('Hello'))
    const server = await start(app)
    const connection = await openConnection(server.port)

    const refused = await connection.exchange(
      requestHead('OPTIONS', '/orders', [`Origin: ${ATTACKER}`, 'Access-Control-Request-Method: POST']),
    )
    const allowed = await connection.exchange(
      requestHead('OPTIONS', '/orders', [`Origin: ${SHOP}`, 'Access-Control-Request-Method: POST']),
    )
    const page = await connection.exchange(requestHead('GET', '/hello', [`Origin: ${ATTACKER}`]))

    expect(refused.status).toBe(204)
    expect(refused.headers.get('allow')).toEqual(['POST, OPTIONS'])
    expect(refused.headers.has('access-control-allow-origin')).toBe(false)
    expect(refused.headers.has('access-control-allow-methods')).toBe(false)
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toEqual([SHOP])
    expect(allowed.headers.get('access-control-allow-methods')).toEqual(['GET, HEAD, PUT, POST, DELETE, PATCH'])
    expect(allowed.headers.has('vary')).toBe(false)
    expect([page.status, page.body.toString()]).toEqual([200, 'Hello'])
    expect(page.headers.get('access-control-allow-origin')).toEqual([SHOP])
    expect(page.headers.get('access-control-allow-credentials')).toEqual(['true'])
    expect(page.headers.has('vary')).toBe(false)
    expect(connection.state).toBe('open')
  })

  it('sends the CORS headers with the reply to a POST with a body, on the connection of its preflight', async () => {
    const server = await start(corsApp())
    const connection = await openConnection(server.port)

    const preflight = await connection.exchange(
      requestHead('OPTIONS', '/orders', [`Origin: ${SHOP}`, 'Access-Control-Request-Method: POST']),
    )
    const order = await connection.exchange(
      requestWithBody('POST', '/orders', [`Origin: ${SHOP}`, 'Content-Type: application/json'], '{"sku":"shoe-1"}'),
    )

    expect(preflight.status).toBe(204)
    expect(order.status).toBe(200)
    expect(order.headers.get('access-control-allow-origin')).toEqual([SHOP])
    expect(order.headers.get('vary')).toEqual(['Origin'])
    expect(order.body.toString()).toBe('{"placed":true}')
    expect(connection.state).toBe('open')
  })

  it('rejects a cross-site form post with its body before the handler, and keeps the connection open', async () => {
    const handled: string[] = []
    const server = await start(csrfApp(handled))

    const { connection, response } = await send(
      server.port,
      requestWithBody('POST', '/transfer', FORM_LINES, 'to=attacker&amount=1000'),
    )

    expect([response.status, response.body.toString()]).toEqual([403, CSRF_REJECTED])
    expect(handled).toEqual([])
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('rejects a cross-site form post with a chunked body, and closes the connection without a reset', async () => {
    const handled: string[] = []
    const server = await start(csrfApp(handled))

    const { connection, response } = await send(
      server.port,
      chunkedRequest('POST', '/transfer', FORM_LINES, ['to=attacker', '&amount=1000']),
    )

    expect([response.status, response.body.toString()]).toEqual([403, CSRF_REJECTED])
    expect(handled).toEqual([])
    await expectClosedAfterReply(connection, response)
  })

  it('passes every byte of the body of a same-origin form post of 200 KiB to the handler', async () => {
    const handled: string[] = []
    const server = await start(csrfApp(handled))
    const form = `to=friend&note=${'a'.repeat(200 * 1024)}`

    const { connection, response } = await send(
      server.port,
      requestWithBody(
        'POST',
        '/transfer',
        ['Content-Type: application/x-www-form-urlencoded', 'Sec-Fetch-Site: same-origin'],
        form,
      ),
    )

    expect([response.status, response.body.toString()]).toEqual([200, 'moved'])
    expect(handled).toEqual([form])
    expect(connection.state).toBe('open')
  })
})
