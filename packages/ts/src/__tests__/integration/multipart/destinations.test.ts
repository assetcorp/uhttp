import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type TestRequestInit, type UploadDestination } from '../../../index.js'
import { MIB } from '../../helpers/apps.js'
import { BOUNDARY, errorCodeOf, forEverySplit, multipartBody, multipartType } from '../../helpers/body.js'

const CHUNK_BYTES = 16_384
const FILE_CHUNKS = 64

let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'uhttp-uploads-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function diskApp(options: { maxFileBytes?: number } = {}) {
  return createApp().post('/upload', async c => {
    const result = await c.req.body.multipart({
      ...options,
      file: file => createWriteStream(join(directory, `${file.field}-${file.filename}`)),
    })
    return c.json(result.files.map(file => ({ filename: file.filename, size: file.size, bytes: file.bytes })))
  })
}

function post(body: Uint8Array | AsyncIterable<Uint8Array>, signal?: AbortSignal): TestRequestInit {
  const init = { method: 'POST', headers: { 'content-type': multipartType() }, body }
  return signal === undefined ? init : { ...init, signal }
}

function fileHeadOf(filename: string): string {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
}

async function* largeUpload(onChunk: (index: number) => void): AsyncGenerator<Uint8Array> {
  yield Buffer.from(fileHeadOf('clip.bin'))
  for (let index = 0; index < FILE_CHUNKS; index++) {
    onChunk(index)
    yield new Uint8Array(CHUNK_BYTES).fill(index % 256)
  }
  yield Buffer.from(`\r\n--${BOUNDARY}--\r\n`)
}

describe('multipart() with a destination for each file', () => {
  it('streams each file into a file on disk and keeps the fields in memory', async () => {
    const body = multipartBody([
      { name: 'caption', value: 'Kakum canopy' },
      { name: 'photo', filename: 'canopy.jpg', contentType: 'image/jpeg', content: 'jpeg bytes' },
      { name: 'photo', filename: 'trail.jpg', contentType: 'image/jpeg', content: 'more jpeg bytes' },
    ])

    await forEverySplit(diskApp(), '/upload', body, multipartType(), async (response, position) => {
      expect(await response.json(), `split at byte ${position}`).toEqual([
        { filename: 'canopy.jpg', size: 10 },
        { filename: 'trail.jpg', size: 15 },
      ])
      expect(readFileSync(join(directory, 'photo-canopy.jpg'), 'utf8')).toBe('jpeg bytes')
      expect(readFileSync(join(directory, 'photo-trail.jpg'), 'utf8')).toBe('more jpeg bytes')
    })
  })

  it('writes into a web WritableStream', async () => {
    let received: string[] = []
    const app = createApp().post('/upload', async c => {
      received = []
      await c.req.body.multipart({
        file: () =>
          new WritableStream<Uint8Array>({
            write: chunk => {
              received.push(Buffer.from(chunk).toString())
            },
          }),
      })
      return c.text('stored')
    })
    const body = multipartBody([{ name: 'f', filename: 'a.txt', content: 'web stream' }])

    await forEverySplit(app, '/upload', body, multipartType(), async (response, position) => {
      expect(await response.text(), `split at byte ${position}`).toBe('stored')
      expect(received.join('')).toBe('web stream')
    })
  })

  it('stops pulling the body while a destination is busy, and resumes once it accepts more', async () => {
    const pulled: number[] = []
    const releases: (() => void)[] = []
    let stored = 0
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, done) {
        stored += chunk.byteLength
        releases.push(() => done())
      },
    })
    const app = createApp().post('/upload', { maxBodyBytes: 4 * MIB }, async c => {
      await c.req.body.multipart({ file: () => slow })
      return c.text(String(stored))
    })

    let settled = false
    const pending = app.request('/upload', post(largeUpload(index => pulled.push(index)))).finally(() => {
      settled = true
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const pulledWhileBusy = pulled.length
    while (!settled) {
      for (const release of releases.splice(0)) release()
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const response = await pending

    expect(pulledWhileBusy).toBeLessThan(10)
    expect(await response.text()).toBe(String(CHUNK_BYTES * FILE_CHUNKS))
  })

  it('destroys every destination and deletes every partial file when a limit trips', async () => {
    const body = multipartBody([
      { name: 'a', filename: 'small.txt', content: 'ok' },
      { name: 'b', filename: 'large.txt', content: 'x'.repeat(100) },
    ])

    await forEverySplit(diskApp({ maxFileBytes: 50 }), '/upload', body, multipartType(), async (response, position) => {
      expect(response.status, `split at byte ${position}`).toBe(413)
      expect(await errorCodeOf(response)).toBe('PAYLOAD_TOO_LARGE')
      expect(existsSync(join(directory, 'a-small.txt'))).toBe(false)
      expect(existsSync(join(directory, 'b-large.txt'))).toBe(false)
    })
  })

  it('keeps the files of a finished upload when the handler later passes its time limit', async () => {
    const app = createApp({ timeoutMs: 50 }).post('/upload', async c => {
      await c.req.body.multipart({ file: file => createWriteStream(join(directory, file.filename)) })
      return new Promise<never>(() => undefined)
    })

    const response = await app.request(
      '/upload',
      post(multipartBody([{ name: 'f', filename: 'kept.txt', content: 'kept' }])),
    )
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(response.status).toBe(503)
    expect(readFileSync(join(directory, 'kept.txt'), 'utf8')).toBe('kept')
  })

  it('destroys the destination and deletes the partial file when the handler passes its time limit', async () => {
    const app = createApp({ timeoutMs: 50 }).post('/upload', { maxBodyBytes: 4 * MIB }, async c => {
      await c.req.body.multipart({ file: file => createWriteStream(join(directory, file.filename)) })
      return c.text('stored')
    })
    async function* stalled(): AsyncGenerator<Uint8Array> {
      yield Buffer.from(fileHeadOf('slow.bin'))
      yield new Uint8Array(1024)
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }

    const response = await app.request('/upload', post(stalled()))
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(response.status).toBe(503)
    expect(existsSync(join(directory, 'slow.bin'))).toBe(false)
  })

  it('calls discard on a destination when the client goes', async () => {
    const controller = new AbortController()
    const discarded = Promise.withResolvers<string>()
    let destroyed = false
    const app = createApp().post('/upload', async c => {
      await c.req.body.multipart({
        file: (): UploadDestination => ({
          stream: new Writable({
            write(_chunk, _encoding, done) {
              controller.abort()
              done()
            },
            destroy(error, done) {
              destroyed = true
              done(error)
            },
          }),
          discard: () => discarded.resolve('discarded'),
        }),
      })
      return c.text('stored')
    })

    await app.request(
      '/upload',
      post(
        largeUpload(() => undefined),
        controller.signal,
      ),
    )

    expect(await discarded.promise).toBe('discarded')
    expect(destroyed).toBe(true)
  })

  it('answers 500 with INVALID_UPLOAD when the file callback returns something that is not a stream', async () => {
    const codes: string[] = []
    const app = createApp({
      onError: (error, c) => {
        codes.push((error as { code: string }).code)
        return c.text('failed', 500)
      },
    }).post('/upload', async c => {
      await c.req.body.multipart({ file: () => ({}) as UploadDestination })
      return c.text('stored')
    })

    await app.request('/upload', post(multipartBody([{ name: 'f', filename: 'a.txt', content: 'x' }])))

    expect(codes).toEqual(['INVALID_UPLOAD'])
  })
})

describe('the pause timer of an upload', () => {
  beforeEach(async () => {
    await createApp().request('/')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('treats the client as gone once the upload stays paused for 10 seconds', async () => {
    const signals: AbortSignal[] = []
    const app = createApp().post('/upload', { maxBodyBytes: 4 * MIB }, async c => {
      signals.push(c.req.signal)
      await c.req.body.multipart({ file: () => new Writable({ highWaterMark: 1, write: () => undefined }) })
      return c.text('stored')
    })

    const pending = app.request('/upload', post(largeUpload(() => undefined)))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(signals[0]?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0]?.aborted).toBe(true)
    await pending
  })
})
