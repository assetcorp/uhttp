import { describe, expect, it } from 'vitest'
import { createApp, type TestHeaders } from '../../index.js'
import { rawRequest } from '../helpers/raw-http.js'
import { start } from '../helpers/server.js'

const PARSER_ERROR_BODY = '<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>'

interface Case {
  name: string
  lines: readonly (readonly [string, string])[]
}

function headerCount(count: number): Case {
  return {
    name: `${count} header lines`,
    lines: [['Host', 'localhost'], ...Array.from({ length: count - 1 }, (_, index) => [`x-${index}`, 'v'] as const)],
  }
}

function headBytes(bytes: number): Case {
  const fixed = 'GET /headers HTTP/1.1\r\nHost: localhost\r\nx-pad: \r\n\r\n'.length
  return {
    name: `a head of ${bytes} bytes`,
    lines: [
      ['Host', 'localhost'],
      ['x-pad', 'a'.repeat(bytes - fixed)],
    ],
  }
}

const CASES: readonly Case[] = [
  headerCount(98),
  headerCount(99),
  headBytes(4096),
  headBytes(4097),
  { name: 'an empty Host', lines: [['Host', '']] },
  {
    name: 'a repeated Host',
    lines: [
      ['Host', 'a.example'],
      ['Host', 'b.example'],
    ],
  },
  { name: 'a Host with a comma', lines: [['Host', 'a,b']] },
  { name: 'a Host with an @', lines: [['Host', 'user@example.com']] },
  {
    name: 'Content-Length with Transfer-Encoding',
    lines: [
      ['Host', 'localhost'],
      ['Content-Length', '0'],
      ['Transfer-Encoding', 'chunked'],
    ],
  },
  {
    name: 'a mixed-case header name',
    lines: [
      ['Host', 'localhost'],
      ['X-Mixed-Case', 'kept'],
    ],
  },
]

describe('app.request() and uWebSockets.js', () => {
  it('give the same status and body for the requests that the parser of uWebSockets.js checks', async () => {
    const app = createApp().get('/headers', { headers: 'all' }, c => c.json(c.req.headers()))
    const server = await start(app)

    for (const { name, lines } of CASES) {
      const head = ['GET /headers HTTP/1.1', ...lines.map(([key, value]) => `${key}: ${value}`), '', ''].join('\r\n')
      const native = await rawRequest(server.port, head)
      const headers: TestHeaders = lines
      const tested = await app.request('/headers', { headers })

      expect({ status: tested.status, body: await tested.text() }, name).toEqual({
        status: native.status,
        body: native.body.toString(),
      })
    }
  })
})

describe('the parser of uWebSockets.js', () => {
  it('sends HTML outside the JSON contract of the package for a request with no Host', async () => {
    const server = await start(createApp())

    const response = await rawRequest(server.port, 'GET /users HTTP/1.1\r\n\r\n')

    expect(response.status).toBe(400)
    expect(response.body.toString()).toBe(PARSER_ERROR_BODY)
  })
})
