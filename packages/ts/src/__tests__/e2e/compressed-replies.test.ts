import { randomBytes } from 'node:crypto'
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { compression } from '../../middleware/compression/index.js'
import { MIB } from '../helpers/apps.js'
import { openConnection, requestHead, send } from '../helpers/http-client.js'
import { expectHello } from '../helpers/replies.js'
import { pause, start } from '../helpers/server.js'

const CATALOGUE = JSON.stringify(
  Array.from({ length: 400 }, (_, index) => ({ sku: `shoe-${index}`, name: `Running shoe ${index}`, stock: index })),
)
const CHUNK_COUNT = 32
const PIECES = Array.from({ length: CHUNK_COUNT }, () => randomBytes(MIB / 4).toString('base64'))
const SLOW_CLIENT_TIMEOUT_MS = 30_000
const SETTLE_LIMIT_MS = 10_000
const SETTLE_QUIET_MS = 400
const STREAMED_TEXT = PIECES.join('')

interface Progress {
  written: number
  done: boolean
  stopped: boolean
}

function compressedApp(progress: Progress) {
  return createApp()
    .use(compression())
    .get('/catalogue', c => c.json(JSON.parse(CATALOGUE)))
    .get('/feed', c =>
      c.stream(
        async stream => {
          for (const piece of PIECES) {
            if (!(await stream.write(piece))) {
              progress.stopped = true
              return
            }
            progress.written++
          }
          progress.done = true
        },
        { contentType: 'text/plain; charset=utf-8' },
      ),
    )
    .get('/hello', c => c.text('Hello'))
}

function freshProgress(): Progress {
  return { written: 0, done: false, stopped: false }
}

async function settledProgress(progress: Progress): Promise<number> {
  const deadline = Date.now() + SETTLE_LIMIT_MS
  let seen = -1
  while (progress.written !== seen && !progress.done && Date.now() < deadline) {
    seen = progress.written
    await pause(SETTLE_QUIET_MS)
  }
  return progress.written
}

describe('compressed replies over the network', () => {
  it.each([
    ['gzip', gunzipSync],
    ['br', brotliDecompressSync],
    ['zstd', zstdDecompressSync],
  ])('sends a JSON body in %s with its compressed length, and keeps the connection open', async (encoding, decode) => {
    const server = await start(compressedApp(freshProgress()))

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/catalogue', [`Accept-Encoding: ${encoding}`]),
    )

    expect(response.status).toBe(200)
    expect(response.framing).toBe('length')
    expect(response.headers.get('content-encoding')).toEqual([encoding])
    expect(response.headers.get('vary')).toEqual(['Accept-Encoding'])
    expect(response.headers.get('content-length')).toEqual([String(response.body.length)])
    expect(response.body.length).toBeLessThan(CATALOGUE.length)
    expect(decode(response.body).toString()).toBe(CATALOGUE)
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('sends the JSON body unchanged to a client that sends no Accept-Encoding', async () => {
    const server = await start(compressedApp(freshProgress()))

    const { connection, response } = await send(server.port, requestHead('GET', '/catalogue'))

    expect(response.headers.has('content-encoding')).toBe(false)
    expect(response.headers.get('vary')).toEqual(['Accept-Encoding'])
    expect(response.body.toString()).toBe(CATALOGUE)
    expect(connection.state).toBe('open')
  })

  it('pauses the producer while the client reads a chunked Brotli stream slowly, then sends every byte', {
    timeout: SLOW_CLIENT_TIMEOUT_MS,
  }, async () => {
    const progress = freshProgress()
    const server = await start(compressedApp(progress))
    const connection = await openConnection(server.port)

    connection.pauseReading()
    void connection.write(requestHead('GET', '/feed', ['Accept-Encoding: br']))
    const heldAt = await settledProgress(progress)
    connection.resumeReading()
    const response = await connection.response({ waitMs: SLOW_CLIENT_TIMEOUT_MS })

    expect(heldAt).toBeLessThan(CHUNK_COUNT)
    expect(response.framing).toBe('chunked')
    expect(response.headers.get('content-encoding')).toEqual(['br'])
    expect(response.headers.has('content-length')).toBe(false)
    expect(brotliDecompressSync(response.body).toString()).toBe(STREAMED_TEXT)
    expect(progress.done).toBe(true)
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('stops the producer of a compressed stream when the client disconnects, and serves the next client', {
    timeout: SLOW_CLIENT_TIMEOUT_MS,
  }, async () => {
    const progress = freshProgress()
    const server = await start(compressedApp(progress))
    const connection = await openConnection(server.port)

    connection.pauseReading()
    void connection.write(requestHead('GET', '/feed', ['Accept-Encoding: gzip']))
    await settledProgress(progress)
    connection.destroy()
    const deadline = Date.now() + SETTLE_LIMIT_MS
    while (!progress.stopped && Date.now() < deadline) await pause(20)

    expect(progress.stopped).toBe(true)
    expect(progress.done).toBe(false)
    expect(progress.written).toBeLessThan(CHUNK_COUNT)
    const next = await openConnection(server.port)
    await expectHello(next)
    expect(next.state).toBe('open')
  })

  it('delivers a compressed body that the fetch client of Node.js decodes', async () => {
    const server = await start(compressedApp(freshProgress()))

    const response = await fetch(`http://127.0.0.1:${server.port}/catalogue`)

    expect(response.headers.get('content-encoding')).not.toBeNull()
    expect(await response.text()).toBe(CATALOGUE)
  })
})
