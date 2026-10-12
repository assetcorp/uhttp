import { describe, expect, it, vi } from 'vitest'
import { createApp, type TestHeaders, UhttpError } from '../../index.js'
import { openConnection, send } from '../helpers/http-client.js'
import { expectClosedAfterReply, expectHello, SMUGGLED_REQUEST } from '../helpers/replies.js'
import { start } from '../helpers/server.js'

const PARSER_ERROR_BODY = '<h1>Bad Request</h1><hr><i>uWebSockets/20 Server</i>'
const HELLO_CHUNKS = '5\r\nhello\r\n0\r\n\r\n'

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
    name: 'a mixed-case header name',
    lines: [
      ['Host', 'localhost'],
      ['X-Mixed-Case', 'kept'],
    ],
  },
]

function echoRequest(lines: readonly string[], body: string): string {
  const head = ['POST /echo HTTP/1.1', 'Host: localhost', 'Content-Type: text/plain', ...lines].join('\r\n')
  return `${head}\r\n\r\n${body}`
}

function echoApp(handled: string[]) {
  return createApp()
    .post('/echo', async c => {
      handled.push('echo')
      try {
        return c.text(`[${await c.req.body.text()}]`)
      } catch (error) {
        handled.push(error instanceof UhttpError ? error.code : String(error))
        throw error
      }
    })
    .get('/admin', c => {
      handled.push('admin')
      return c.text('admin')
    })
    .get('/hello', c => c.text('Hello'))
}

const MALFORMED_HEADS: readonly (readonly [string, string])[] = [
  [
    'Content-Length with Transfer-Encoding',
    echoRequest(['Content-Length: 0', 'Transfer-Encoding: chunked'], HELLO_CHUNKS),
  ],
  [
    'Transfer-Encoding with Content-Length',
    echoRequest(['Transfer-Encoding: chunked', 'Content-Length: 5'], '0\r\n\r\n'),
  ],
  ['two different Content-Length values', echoRequest(['Content-Length: 5', 'Content-Length: 6'], 'hello!')],
  ['a Content-Length with a plus sign', echoRequest(['Content-Length: +5'], 'hello')],
  ['a negative Content-Length', echoRequest(['Content-Length: -1'], 'hello')],
  ['a Content-Length with a space inside', echoRequest(['Content-Length: 5 5'], 'hello')],
  ['a hexadecimal Content-Length', echoRequest(['Content-Length: 0x5'], 'hello')],
  ['a Content-Length list', echoRequest(['Content-Length: 5,5'], 'hello')],
  ['a Content-Length that overflows', echoRequest(['Content-Length: 99999999999999999999'], 'hello')],
  ['whitespace before the colon of Content-Length', echoRequest(['Content-Length : 5'], 'hello')],
  ['a Transfer-Encoding of gzip', echoRequest(['Transfer-Encoding: gzip'], HELLO_CHUNKS)],
  ['a Transfer-Encoding that ends with gzip', echoRequest(['Transfer-Encoding: chunked, gzip'], HELLO_CHUNKS)],
  ['a Transfer-Encoding of identity', echoRequest(['Transfer-Encoding: identity'], HELLO_CHUNKS)],
  ['a folded header line', echoRequest(['Content-Length: 5', 'X-Note: a', ' b'], 'hello')],
  ['a NUL in a header value', echoRequest(['Content-Length: 5', 'X-Note: a\0b'], 'hello')],
  ['a parenthesis in a header name', echoRequest(['Content-Length: 5', 'X(Note): a'], 'hello')],
  ['request lines that end in LF alone', 'GET /hello HTTP/1.1\nHost: localhost\n\n'],
  ['a Transfer-Encoding of xchunked', echoRequest(['Transfer-Encoding: xchunked'], HELLO_CHUNKS)],
  [
    'a chunked Transfer-Encoding followed by a line of identity',
    echoRequest(['Transfer-Encoding: chunked', 'Transfer-Encoding: identity'], HELLO_CHUNKS),
  ],
]

const MALFORMED_CHUNKS: readonly (readonly [string, string])[] = [
  ['a chunk size that overflows', `10000000000000005\r\nhello\r\n0\r\n\r\n`],
  ['a chunk size that is not hexadecimal', 'zz\r\nhello\r\n0\r\n\r\n'],
  ['a chunk longer than its size', '2\r\nhello\r\n0\r\n\r\n'],
  ['chunk lines that end in LF alone', '5\nhello\n0\n\n'],
]

describe('app.request() and uWebSockets.js', () => {
  it('give the same status and body for the requests that the parser of uWebSockets.js checks', async () => {
    const app = createApp().get('/headers', { headers: 'all' }, c => c.json(c.req.headers()))
    const server = await start(app)

    for (const { name, lines } of CASES) {
      const head = ['GET /headers HTTP/1.1', ...lines.map(([key, value]) => `${key}: ${value}`), '', ''].join('\r\n')
      const { connection, response } = await send(server.port, head)
      const headers: TestHeaders = lines
      const tested = await app.request('/headers', { headers })

      expect({ status: tested.status, body: await tested.text() }, name).toEqual({
        status: response.status,
        body: response.body.toString(),
      })
      expect(await connection.waitForClose(response.status === 400 ? 2_000 : 100), name).toBe(
        response.status === 400 ? 'closed' : 'open',
      )
    }
  })
})

describe('the parser of uWebSockets.js', () => {
  it('sends HTML outside the JSON contract of the package for a request with no Host, and closes the connection', async () => {
    const server = await start(createApp())

    const { connection, response } = await send(server.port, 'GET /users HTTP/1.1\r\n\r\n')

    expect([response.status, response.body.toString()]).toEqual([400, PARSER_ERROR_BODY])
    expect(await connection.waitForClose()).toBe('closed')
  })

  it.each(MALFORMED_HEADS)(
    'answers 400 to %s before it calls any handler, closes the connection, and serves no request hidden behind it',
    async (_name, request) => {
      const handled: string[] = []
      const server = await start(echoApp(handled))

      const { connection, response } = await send(server.port, `${request}${SMUGGLED_REQUEST}`)

      expect(response.status).toBe(400)
      expect(await connection.waitForClose()).toBe('closed')
      expect(handled).toEqual([])
    },
  )

  it.each(MALFORMED_CHUNKS)(
    'answers 400 to a chunked body with %s, fails the read in the handler, and serves no request hidden behind it',
    async (_name, body) => {
      const handled: string[] = []
      const server = await start(echoApp(handled))

      const { connection, response } = await send(
        server.port,
        `${echoRequest(['Transfer-Encoding: chunked'], body)}${SMUGGLED_REQUEST}`,
      )

      expect(response.status).toBe(400)
      expect(await connection.waitForClose()).toBe('closed')
      await vi.waitFor(() => expect(handled).toEqual(['echo', 'REQUEST_ABORTED']))
    },
  )

  it('answers 501 to a Transfer-Encoding of gzip before chunked, which the package cannot decode, before it calls any handler', async () => {
    const handled: string[] = []
    const server = await start(echoApp(handled))

    const { connection, response } = await send(
      server.port,
      `${echoRequest(['Transfer-Encoding: gzip, chunked'], HELLO_CHUNKS)}${SMUGGLED_REQUEST}`,
    )

    expect(response.status).toBe(501)
    expect(response.headers.get('connection')).toEqual(['close'])
    expect(response.body.toString()).toBe(
      JSON.stringify({
        error: {
          code: 'UNSUPPORTED_TRANSFER_CODING',
          message: 'Send the request body with the chunked transfer coding alone, because the server decodes no other.',
        },
      }),
    )
    expect(await connection.waitForClose()).toBe('closed')
    expect(handled).toEqual([])
  })

  it('answers 501 at once to a Transfer-Encoding of gzip before chunked while the body is still arriving, and closes the connection without a reset', async () => {
    const handled: string[] = []
    const server = await start(echoApp(handled))
    const connection = await openConnection(server.port)

    void connection.write(echoRequest(['Transfer-Encoding: gzip, chunked'], '5\r\nhello\r\n'))
    const response = await connection.response()
    void connection.write('5\r\nworld\r\n0\r\n\r\n')

    expect(response.status).toBe(501)
    expect(handled).toEqual([])
    await expectClosedAfterReply(connection, response)
  })

  it('answers a HEAD request with a Transfer-Encoding of xchunked with a 400 head and no body, as app.request() does', async () => {
    const app = echoApp([])
    const server = await start(app)
    const head = 'HEAD /hello HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: xchunked\r\n\r\n'

    const { connection, response } = await send(server.port, `${head}${HELLO_CHUNKS}`, { method: 'HEAD' })
    const tested = await app.request('/hello', {
      method: 'HEAD',
      headers: { 'transfer-encoding': 'xchunked' },
      body: 'hello',
    })

    expect([response.status, response.body.length]).toEqual([400, 0])
    expect([tested.status, await tested.text()]).toEqual([400, ''])
    expect(response.headers.get('content-length')).toEqual([tested.headers.get('content-length')])
    expect(await connection.waitForClose()).toBe('closed')
  })

  it('answers 400 with INVALID_TRANSFER_ENCODING to a Transfer-Encoding of xchunked, and sends nothing else on the connection', async () => {
    const server = await start(echoApp([]))

    const { connection, response } = await send(
      server.port,
      `${echoRequest(['Transfer-Encoding: xchunked'], HELLO_CHUNKS)}GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n`,
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('connection')).toEqual(['close'])
    expect(JSON.parse(response.body.toString())).toEqual({
      error: {
        code: 'INVALID_TRANSFER_ENCODING',
        message: 'The transfer-encoding of a request must list chunked once, as its last coding.',
      },
    })
    expect(await connection.waitForClose()).toBe('closed')
  })

  it.fails('answers 400 to a bare CR inside a header value, which uWebSockets.js v20.71.0 leaves unanswered until its idle timeout', async () => {
    const server = await start(echoApp([]))

    const { connection, response } = await send(
      server.port,
      'GET /hello HTTP/1.1\r\nHost: localhost\r\nX-Note: a\rb\r\n\r\n',
    )

    expect(response.status).toBe(400)
    expect(await connection.waitForClose()).toBe('closed')
  })

  it.each([
    ['a Transfer-Encoding of Chunked in another case', ['Transfer-Encoding: Chunked'], HELLO_CHUNKS],
    ['a Transfer-Encoding of chunked with trailing whitespace', ['Transfer-Encoding: chunked '], HELLO_CHUNKS],
    ['a chunk extension', ['Transfer-Encoding: chunked'], '5;name=value\r\nhello\r\n0\r\n\r\n'],
    ['a Content-Length with whitespace before it', ['Content-Length:  5'], 'hello'],
    ['a Content-Length with a leading zero', ['Content-Length: 05'], 'hello'],
    ['two identical Content-Length lines', ['Content-Length: 5', 'Content-Length: 5'], 'hello'],
  ])('reads the body of a request with %s, and keeps the connection open', async (_name, lines, body) => {
    const server = await start(echoApp([]))
    const connection = await openConnection(server.port)

    const response = await connection.exchange(echoRequest(lines, body))
    const next = await connection.exchange('GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n')

    expect([response.status, response.body.toString()]).toEqual([200, '[hello]'])
    expect([next.status, next.body.toString()]).toEqual([200, 'Hello'])
  })

  it.fails('reads the body of a request with a trailer field after the last chunk, which uWebSockets.js v20.71.0 answers with a 400', async () => {
    const server = await start(echoApp([]))

    const { connection, response } = await send(
      server.port,
      echoRequest(['Transfer-Encoding: chunked'], '5\r\nhello\r\n0\r\nX-Checksum: 1\r\n\r\n'),
    )

    expect([response.status, response.body.toString()]).toEqual([200, '[hello]'])
    await expectHello(connection)
  })

  it.fails('serves a request whose target is in absolute form, which uWebSockets.js v20.71.0 answers with a 400', async () => {
    const server = await start(echoApp([]))

    const { connection, response } = await send(
      server.port,
      'GET http://localhost/hello HTTP/1.1\r\nHost: localhost\r\n\r\n',
    )

    expect([response.status, response.body.toString()]).toEqual([200, 'Hello'])
    await expectHello(connection)
  })
})
