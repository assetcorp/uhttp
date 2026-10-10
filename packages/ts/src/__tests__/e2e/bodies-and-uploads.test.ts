import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { BOUNDARY, multipartType } from '../helpers/body.js'
import { rawRequest, requestHead } from '../helpers/raw-http.js'
import { pause, start, urlOf } from '../helpers/server.js'

const MIB = 1_048_576

let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'uhttp-e2e-uploads-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function fileHead(filename: string): string {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`
}

describe('request bodies over the network', () => {
  it('keeps every byte of a body that arrives while middleware awaits', async () => {
    const server = await start(
      createApp()
        .use(async (_c, next) => {
          await pause(50)
          await next()
        })
        .post('/users', async c => c.json(await c.req.body.json())),
    )
    const payload = { name: 'Ama', notes: 'n'.repeat(200_000) }

    const response = await fetch(urlOf(server, '/users'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect(await response.json()).toEqual(payload)
  })

  it('reads an empty body from a POST with no length and no chunked encoding', async () => {
    const server = await start(createApp().post('/empty', async c => c.text(`[${await c.req.body.text()}]`)))

    const response = await rawRequest(server.port, requestHead('POST', '/empty', ['Content-Type: text/plain']))

    expect(response.body.toString()).toBe('[]')
  })

  it('answers 413 to a declared length above the limit and closes the connection', async () => {
    let handled = false
    const server = await start(
      createApp({ maxBodyBytes: 100 }).post('/upload', c => {
        handled = true
        return c.text('ok')
      }),
    )

    const response = await rawRequest(server.port, requestHead('POST', '/upload', ['Content-Length: 5000']))

    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toEqual(['close'])
    expect(JSON.parse(response.body.toString())).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) },
    })
    expect(handled).toBe(false)
  })

  it('answers 415 with Accept-Encoding: identity to a compressed body and closes the connection', async () => {
    const server = await start(createApp().post('/upload', c => c.text('ok')))

    const response = await rawRequest(
      server.port,
      `${requestHead('POST', '/upload', ['Content-Length: 3', 'Content-Encoding: br'])}abc`,
    )

    expect(response.status).toBe(415)
    expect(response.headers.get('accept-encoding')).toEqual(['identity'])
    expect(response.headers.get('connection')).toEqual(['close'])
  })

  it('counts a chunked body as it arrives and answers 413 once it passes the limit', async () => {
    const server = await start(
      createApp({ maxBodyBytes: 10 }).post('/upload', async c => {
        let total = 0
        for await (const chunk of c.req.body.stream()) total += chunk.byteLength
        return c.text(String(total))
      }),
    )
    const chunk = (text: string) => `${text.length.toString(16)}\r\n${text}\r\n`

    const response = await rawRequest(
      server.port,
      `${requestHead('POST', '/upload', ['Transfer-Encoding: chunked'])}${chunk('123456')}${chunk('789012')}0\r\n\r\n`,
    )

    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toEqual(['close'])
  })

  it('pauses the socket while a destination is busy and finishes the upload once it accepts more', async () => {
    const gate = Promise.withResolvers<void>()
    const server = await start(
      createApp().post('/upload', { maxBodyBytes: 64 * MIB }, async c => {
        const { files } = await c.req.body.multipart({
          file: () =>
            new Writable({
              highWaterMark: 1,
              write(_chunk, _encoding, done) {
                void gate.promise.then(() => done())
              },
            }),
        })
        return c.json({ size: files[0]?.size })
      }),
    )
    const fileBytes = 32 * MIB
    const head = fileHead('large.bin')
    const tail = `\r\n--${BOUNDARY}--\r\n`
    const socket = connect(server.port, '127.0.0.1')
    const received: Buffer[] = []
    const closed = Promise.withResolvers<void>()
    socket.on('data', data => received.push(data))
    socket.on('close', () => closed.resolve())
    socket.write(
      requestHead('POST', '/upload', [
        `Content-Type: ${multipartType()}`,
        `Content-Length: ${Buffer.byteLength(head) + fileBytes + Buffer.byteLength(tail)}`,
        'Connection: close',
      ]),
    )
    socket.write(head)
    for (let sent = 0; sent < fileBytes; sent += MIB) socket.write(new Uint8Array(MIB).fill(7))
    socket.write(tail)

    await pause(500)
    const unsentWhilePaused = socket.writableLength
    gate.resolve()
    await closed.promise

    expect(unsentWhilePaused).toBeGreaterThan(0)
    expect(Buffer.concat(received).toString()).toContain(`{"size":${fileBytes}}`)
  }, 20_000)

  it('deletes a partial file when the client goes during the upload', async () => {
    const started = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<string>()
    const server = await start(
      createApp().post('/upload', { maxBodyBytes: 64 * MIB }, async c => {
        try {
          await c.req.body.multipart({
            file: file => {
              started.resolve()
              return createWriteStream(join(directory, file.filename))
            },
          })
          finished.resolve('stored')
        } catch (error) {
          finished.resolve((error as { code: string }).code)
        }
        return c.text('done')
      }),
    )
    const socket = connect(server.port, '127.0.0.1')
    socket.write(requestHead('POST', '/upload', [`Content-Type: ${multipartType()}`, `Content-Length: ${8 * MIB}`]))
    socket.write(fileHead('partial.bin'))
    socket.write(new Uint8Array(MIB))
    await started.promise
    await pause(50)
    socket.destroy()

    expect(await finished.promise).toBe('REQUEST_ABORTED')
    await pause(50)
    expect(existsSync(join(directory, 'partial.bin'))).toBe(false)
    expect(readdirSync(directory)).toEqual([])
  })

  it('answers 503 with HANDLER_TIMEOUT once the time limit passes and closes the connection', async () => {
    const server = await start(createApp({ timeoutMs: 100 }).get('/hang', () => new Promise(() => undefined)))

    const response = await rawRequest(server.port, requestHead('GET', '/hang'))

    expect(response.status).toBe(503)
    expect(response.headers.get('connection')).toEqual(['close'])
    expect(JSON.parse(response.body.toString()).error.code).toBe('HANDLER_TIMEOUT')
  })

  it('sends a large streamed reply to a POST whose handler leaves a large body unread', async () => {
    const replyBytes = 8 * MIB
    const server = await start(
      createApp().post('/report', { maxBodyBytes: 16 * MIB }, c =>
        c.stream(
          async stream => {
            for (let sent = 0; sent < replyBytes; sent += MIB) await stream.write(new Uint8Array(MIB).fill(65))
          },
          { length: replyBytes },
        ),
      ),
    )
    const socket = connect(server.port, '127.0.0.1')
    let received = 0
    const done = Promise.withResolvers<number>()
    socket.on('data', data => {
      received += data.length
      if (received > replyBytes) done.resolve(received)
    })
    socket.write(requestHead('POST', '/report', [`Content-Length: ${4 * MIB}`]))
    socket.write(new Uint8Array(4 * MIB))
    const timer = setTimeout(() => done.resolve(received), 5_000)

    const total = await done.promise
    clearTimeout(timer)
    socket.destroy()

    expect(total).toBeGreaterThan(replyBytes)
  }, 10_000)

  it('leaves the files of a completed upload on disk', async () => {
    const server = await start(
      createApp().post('/upload', async c => {
        await c.req.body.multipart({ file: file => createWriteStream(join(directory, file.filename)) })
        return c.text('stored')
      }),
    )
    const body = `${fileHead('kept.txt')}kept\r\n--${BOUNDARY}--\r\n`

    const response = await fetch(urlOf(server, '/upload'), {
      method: 'POST',
      headers: { 'content-type': multipartType() },
      body,
    })

    expect(await response.text()).toBe('stored')
    expect(statSync(join(directory, 'kept.txt')).size).toBe(4)
  })
})
