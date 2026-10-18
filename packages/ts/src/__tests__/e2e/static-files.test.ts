import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { serveStatic } from '../../middleware/static/index.js'
import { MIB } from '../helpers/apps.js'
import { openConnection, requestHead, send } from '../helpers/http-client.js'
import { errorBody, expectHello } from '../helpers/replies.js'
import { pause, start } from '../helpers/server.js'

const LARGE_BYTES = 16 * MIB
const APP_SCRIPT = 'console.log("shop")'
const OPEN_DESCRIPTORS = '/dev/fd'
const DESCRIPTOR_WAIT_MS = 2_000
const POLL_MS = 20

let base = ''
let root = ''
let large = Buffer.alloc(0)

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function staticApp() {
  return createApp()
    .use(serveStatic({ root, prefix: '/assets' }))
    .get('/hello', c => c.text('Hello'))
}

function openDescriptors(): number {
  return readdirSync(OPEN_DESCRIPTORS).length
}

async function descriptorsFallTo(limit: number): Promise<number> {
  const deadline = Date.now() + DESCRIPTOR_WAIT_MS
  let count = openDescriptors()
  while (count > limit && Date.now() < deadline) {
    await pause(POLL_MS)
    count = openDescriptors()
  }
  return count
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'uhttp-static-e2e-'))
  root = join(base, 'public')
  mkdirSync(root)
  large = Buffer.alloc(LARGE_BYTES)
  for (let index = 0; index < LARGE_BYTES; index++) large[index] = (index * 31 + 7) % 251
  writeFileSync(join(root, 'video.mp4'), large)
  writeFileSync(join(root, 'app.js'), APP_SCRIPT)
  writeFileSync(join(root, '.env'), 'SECRET=1')
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('static files over the network', () => {
  it('sends every byte of a 16 MiB file to a client that reads slowly, and keeps the connection open', async () => {
    const server = await start(staticApp())
    const connection = await openConnection(server.port)

    connection.pauseReading()
    void connection.write(requestHead('GET', '/assets/video.mp4'))
    await pause(200)
    connection.resumeReading()
    const response = await connection.response({ waitMs: 10_000 })

    expect(response.status).toBe(200)
    expect(response.framing).toBe('length')
    expect(response.headers.get('content-length')).toEqual([String(LARGE_BYTES)])
    expect(response.headers.get('content-type')).toEqual(['video/mp4'])
    expect(sha256(response.body)).toBe(sha256(large))
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('sends a 206 with the bytes of the range, then a 304 for the entity tag, then a HEAD reply, on one connection', async () => {
    const server = await start(staticApp())
    const connection = await openConnection(server.port)

    const part = await connection.exchange(requestHead('GET', '/assets/video.mp4', ['Range: bytes=1000-1999']))
    const tag = part.headers.get('etag')?.[0] ?? ''
    const unchanged = await connection.exchange(requestHead('GET', '/assets/video.mp4', [`If-None-Match: ${tag}`]))
    const head = await connection.exchange(requestHead('HEAD', '/assets/app.js'), { method: 'HEAD' })

    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toEqual([`bytes 1000-1999/${LARGE_BYTES}`])
    expect(part.body.equals(large.subarray(1000, 2000))).toBe(true)
    expect(tag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)
    expect([unchanged.status, unchanged.body.length]).toEqual([304, 0])
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toEqual([String(APP_SCRIPT.length)])
    expect(head.headers.get('content-type')).toEqual(['text/javascript; charset=utf-8'])
    expect(head.body.length).toBe(0)
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('replies 416 to a range past the end and keeps the connection open', async () => {
    const server = await start(staticApp())

    const { connection, response } = await send(
      server.port,
      requestHead('GET', '/assets/app.js', ['Range: bytes=5000-']),
    )

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toEqual([`bytes */${APP_SCRIPT.length}`])
    expect(response.body.toString()).toBe(
      errorBody(
        'RANGE_NOT_SATISFIABLE',
        `The file has ${APP_SCRIPT.length} bytes, so the range starts at or past its end.`,
      ),
    )
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it.each([
    ['an encoded dot segment', '/assets/%2E%2E/secret.txt'],
    ['a doubled slash', '/assets//app.js'],
    ['a hidden file', '/assets/.env'],
    ['a missing file', '/assets/missing.js'],
  ])('answers %s with a 404 and keeps the connection open', async (_name, target) => {
    const server = await start(staticApp())

    const { connection, response } = await send(server.port, requestHead('GET', target))

    expect(response.status).toBe(404)
    expect(response.body.toString()).not.toContain('SECRET')
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('closes the file when the client disconnects in the middle of a large file, and serves the next client', async () => {
    const server = await start(staticApp())
    const before = openDescriptors()
    const connection = await openConnection(server.port)

    connection.pauseReading()
    void connection.write(requestHead('GET', '/assets/video.mp4'))
    await pause(200)
    connection.destroy()

    expect(await descriptorsFallTo(before)).toBeLessThanOrEqual(before)
    const next = await openConnection(server.port)
    const response = await next.exchange(requestHead('GET', '/assets/app.js'))
    expect(response.body.toString()).toBe(APP_SCRIPT)
    expect(next.state).toBe('open')
  })

  it('delivers a file to the fetch client of Node.js, which checks the length against the body', async () => {
    const server = await start(staticApp())

    const response = await fetch(`http://127.0.0.1:${server.port}/assets/video.mp4`)
    const body = Buffer.from(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(body.length).toBe(LARGE_BYTES)
    expect(sha256(body)).toBe(sha256(large))
  })
})
