import { describe, expect, it } from 'vitest'
import { createApp, UhttpError } from '../../../index.js'
import { type AccessLogOptions, accessLog } from '../../../middleware/access-log/index.js'
import { requestId } from '../../../middleware/request-id/index.js'
import { trustedProxies } from '../../../middleware/trusted-proxies/index.js'
import { memoryLogger } from '../../helpers/server.js'

const LINE = /^(\S+) (\S+) (\S+) (\d+\.\d)ms (\S+) (\S+)$/
const LINE_SEPARATOR = String.fromCharCode(0x2028)

function fieldsOf(line: string | undefined) {
  const match = LINE.exec(line ?? '')
  if (match === null) throw new Error(`The line ${JSON.stringify(line)} has the wrong shape.`)
  const [, method, route, status, duration, address, id] = match
  return { method, route, status, duration: Number(duration), address, id }
}

describe('accessLog() line', () => {
  it('logs the method, the route template, the status, the duration, the address, and the ID', async () => {
    const lines: string[] = []
    const app = createApp()
      .use(accessLog({ write: line => lines.push(line) }))
      .use(requestId())
      .get('/users/:id', c => c.text('user', 201))

    const response = await app.request('/users/42?token=secret', {
      clientAddress: '192.0.2.4',
      headers: { cookie: 'session=abc', authorization: 'Bearer xyz' },
    })

    expect(lines).toHaveLength(1)
    const fields = fieldsOf(lines[0])
    expect(fields).toMatchObject({
      method: 'GET',
      route: '/users/:id',
      status: '201',
      address: '192.0.2.4',
      id: response.headers.get('x-request-id'),
    })
    expect(fields.duration).toBeGreaterThanOrEqual(0)
  })

  it('leaves out the query string, the headers, and the cookies', async () => {
    const lines: string[] = []
    const app = createApp()
      .use(accessLog({ write: line => lines.push(line) }))
      .get('/users/:id', c => c.text('user'))

    await app.request('/users/42?token=secret', { headers: { cookie: 'session=abc', 'user-agent': 'agent-x' } })

    expect(lines[0]).not.toMatch(/secret|token|session|abc|agent-x|42/)
  })

  it('writes dashes for a request without a route or an ID', async () => {
    const lines: string[] = []
    const app = createApp()
      .use(accessLog({ write: line => lines.push(line) }))
      .get('/', c => c.text('home'))

    await app.request('/missing')

    expect(fieldsOf(lines[0])).toMatchObject({ method: 'GET', route: '-', status: '404', id: '-' })
  })

  it('logs the client address that trustedProxies() resolved', async () => {
    const lines: string[] = []
    const app = createApp()
      .use(trustedProxies({ trust: ['10.0.0.5'] }))
      .use(accessLog({ write: line => lines.push(line) }))
      .get('/', c => c.text('home'))

    await app.request('/', { clientAddress: '10.0.0.5', headers: { 'x-forwarded-for': '203.0.113.9' } })

    expect(fieldsOf(lines[0]).address).toBe('203.0.113.9')
  })

  it('logs the status of the error reply when the handler throws', async () => {
    const lines: string[] = []
    const app = createApp()
      .use(accessLog({ write: line => lines.push(line) }))
      .get('/', () => {
        throw new UhttpError('NOT_FOUND', 'gone')
      })

    await app.request('/')

    expect(fieldsOf(lines[0]).status).toBe('404')
  })

  it('logs once the stream of a streamed reply ends', async () => {
    const lines: string[] = []
    const app = createApp()
      .use(accessLog({ write: line => lines.push(line) }))
      .get('/stream', c =>
        c.stream(async stream => {
          await stream.write('one')
          await stream.write('two')
        }),
      )

    const response = await app.request('/stream')
    expect(lines).toHaveLength(0)
    expect(await response.text()).toBe('onetwo')

    expect(lines).toHaveLength(1)
    expect(fieldsOf(lines[0]).status).toBe('200')
  })
})

describe('accessLog() escaping', () => {
  it.each(['GE\u007fT', 'GE\u0085T', 'GE\\T', `GE${LINE_SEPARATOR}T`])('escapes the method %j', async method => {
    const lines: string[] = []
    const app = createApp()
      .use(accessLog({ write: line => lines.push(line) }))
      .get('/', c => c.text('home'))

    await app.request('/', { method })

    expect(lines).toHaveLength(1)
    for (const line of lines) {
      expect(line).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u)
      expect(line.split(' ')[0]).not.toBe(method)
    }
  })

  it('caps the length of a line', async () => {
    const lines: string[] = []
    const route = `/${'a'.repeat(4000)}`
    const app = createApp()
      .use(accessLog({ write: line => lines.push(line) }))
      .get(route, c => c.text('ok'))

    await app.request(route)

    expect(lines[0]?.length).toBe(2048)
  })
})

describe('accessLog() failures', () => {
  it('reports a write that throws to the logger and still sends the reply', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger })
      .use(
        accessLog({
          write: () => {
            throw new Error('disk full')
          },
        }),
      )
      .get('/', c => c.text('home'))

    const response = await app.request('/')

    expect(await response.text()).toBe('home')
    expect(entries.filter(entry => entry.level === 'error')).toHaveLength(1)
  })

  it.each([
    ['a string', 'stdout'],
    ['a number', 1],
  ])('throws INVALID_MIDDLEWARE_OPTIONS when write is %s', (_name, write) => {
    const build = () => accessLog({ write } as unknown as AccessLogOptions)
    expect(build).toThrow(expect.objectContaining({ code: 'INVALID_MIDDLEWARE_OPTIONS' }))
  })
})
