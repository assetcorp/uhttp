import { describe, expect, it } from 'vitest'
import { createApp, UhttpError } from '../../index.js'
import { type HttpConnection, openConnection, requestHead } from '../helpers/http-client.js'
import { pause, start } from '../helpers/server.js'

const KIB = 1024
const IDLE_TIMEOUT_MS = 10_000
const LATEST_CLOSE_MS = 13_000
const SLOW_HANDLER_MS = 12_000

async function closedAfterMs(connection: HttpConnection, startedAt: number): Promise<number> {
  const state = await connection.waitForClose(LATEST_CLOSE_MS + 2_000)
  return state === 'open' ? Number.POSITIVE_INFINITY : Date.now() - startedAt
}

describe('slow clients', () => {
  it('closes idle and trickling connections after 10 seconds, and keeps slow but steady transfers open', async () => {
    const outcomes: string[] = []
    const app = createApp()
      .get('/hello', c => c.text('Hello'))
      .post('/count', { maxBodyBytes: 64 * 1024 * KIB }, async c => {
        try {
          let total = 0
          for await (const chunk of c.req.body.stream()) total += chunk.byteLength
          return c.text(String(total))
        } catch (error) {
          outcomes.push(error instanceof UhttpError ? error.code : String(error))
          throw error
        }
      })
      .get('/slow-handler', async c => {
        await pause(SLOW_HANDLER_MS)
        return c.text('late')
      })
      .get('/slow-stream', c =>
        c.stream(async stream => {
          for (let index = 0; index < 12; index++) {
            await stream.write(`tick ${index}\n`)
            await pause(1_000)
          }
        }),
      )
    const server = await start(app)
    const startedAt = Date.now()

    const partialHead = openConnection(server.port).then(async connection => {
      void connection.write('GET /hello HTTP/1.1\r\nHost: local')
      return closedAfterMs(connection, startedAt)
    })

    const trickledBody = openConnection(server.port).then(async connection => {
      const body = 'abcdefgh'
      void connection.write(requestHead('POST', '/count', [`Content-Length: ${body.length}`]))
      for (const byte of body) {
        if (connection.state !== 'open') break
        void connection.write(byte)
        await pause(2_000)
      }
      return closedAfterMs(connection, startedAt)
    })

    const idleAfterReply = openConnection(server.port).then(async connection => {
      await connection.exchange(requestHead('GET', '/hello'))
      return closedAfterMs(connection, startedAt)
    })

    const steadyUpload = openConnection(server.port).then(async connection => {
      const pieces = 120
      void connection.write(requestHead('POST', '/count', [`Content-Length: ${pieces * 10 * KIB}`]))
      for (let index = 0; index < pieces; index++) {
        void connection.write(Buffer.alloc(10 * KIB, 97))
        await pause(100)
      }
      return (await connection.response({ waitMs: 5_000 })).body.toString()
    })

    const slowHandler = openConnection(server.port).then(async connection =>
      (
        await connection.exchange(requestHead('GET', '/slow-handler'), { waitMs: SLOW_HANDLER_MS + 2_000 })
      ).body.toString(),
    )

    const slowStream = openConnection(server.port).then(async connection =>
      (await connection.exchange(requestHead('GET', '/slow-stream'), { waitMs: 15_000 })).body.toString(),
    )

    const [head, trickle, idle, upload, handler, stream] = await Promise.all([
      partialHead,
      trickledBody,
      idleAfterReply,
      steadyUpload,
      slowHandler,
      slowStream,
    ])

    expect(head, 'a head that never ends').toBeGreaterThanOrEqual(IDLE_TIMEOUT_MS - 1_000)
    expect(head, 'a head that never ends').toBeLessThanOrEqual(LATEST_CLOSE_MS)
    expect(trickle, 'a body below 16 KiB a second').toBeLessThanOrEqual(LATEST_CLOSE_MS)
    expect(outcomes, 'a body below 16 KiB a second').toEqual(['REQUEST_ABORTED'])
    expect(idle, 'an idle connection after a reply').toBeGreaterThanOrEqual(IDLE_TIMEOUT_MS - 1_000)
    expect(idle, 'an idle connection after a reply').toBeLessThanOrEqual(LATEST_CLOSE_MS)
    expect(upload, 'an upload at 100 KiB a second for 12 seconds').toBe(String(120 * 10 * KIB))
    expect(handler, 'a handler that takes 12 seconds').toBe('late')
    expect(stream, 'a stream that writes once a second for 12 seconds').toBe(
      Array.from({ length: 12 }, (_, index) => `tick ${index}\n`).join(''),
    )
  }, 30_000)
})
