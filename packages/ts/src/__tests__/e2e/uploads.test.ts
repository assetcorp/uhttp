import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { BOUNDARY, multipartBody, multipartType } from '../helpers/body.js'
import { chunkedRequest, openConnection, requestHead, requestWithBody, send } from '../helpers/http-client.js'
import { CONNECTION_CHOICES, expectConnectionAfterReply, expectHello, piecesOf, tooLarge } from '../helpers/replies.js'
import { pause, start } from '../helpers/server.js'

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

describe('uploads over the network', () => {
  it('pauses the socket while a destination is busy, and finishes the upload once it accepts more', async () => {
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
    const connection = await openConnection(server.port)
    const writes: Promise<void>[] = [
      connection.write(
        requestHead('POST', '/upload', [
          `Content-Type: ${multipartType()}`,
          `Content-Length: ${Buffer.byteLength(head) + fileBytes + Buffer.byteLength(tail)}`,
        ]),
      ),
      connection.write(head),
    ]
    for (let sent = 0; sent < fileBytes; sent += MIB) writes.push(connection.write(new Uint8Array(MIB).fill(7)))
    writes.push(connection.write(tail))

    const flushedWhileBusy = await Promise.race([Promise.all(writes).then(() => true), pause(500).then(() => false)])
    gate.resolve()
    const response = await connection.response({ waitMs: 15_000 })

    expect(flushedWhileBusy).toBe(false)
    expect([response.status, response.body.toString()]).toEqual([200, `{"size":${fileBytes}}`])
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
    const connection = await openConnection(server.port)

    void connection.write(
      requestHead('POST', '/upload', [`Content-Type: ${multipartType()}`, `Content-Length: ${8 * MIB}`]),
    )
    void connection.write(fileHead('partial.bin'))
    void connection.write(new Uint8Array(MIB))
    await started.promise
    await pause(50)
    connection.destroy()

    expect(await finished.promise).toBe('REQUEST_ABORTED')
    await pause(50)
    expect(readdirSync(directory)).toEqual([])
  })

  it('stores each file under the basename of the filename that the client sent, and keeps the connection open', async () => {
    const server = await start(
      createApp()
        .post('/upload', async c => {
          const { files } = await c.req.body.multipart({
            file: file => createWriteStream(join(directory, file.filename)),
          })
          return c.json(files.map(file => [file.filename, file.size]))
        })
        .get('/hello', c => c.text('Hello')),
    )
    const body = multipartBody([
      { name: 'file', filename: 'kept.txt', content: 'kept' },
      { name: 'file', filename: '../../escaped.txt', content: 'up' },
      { name: 'file', filename: '..\\..\\escaped-too.txt', content: 'back' },
    ])
    const connection = await openConnection(server.port)

    const response = await connection.exchange(
      requestWithBody('POST', '/upload', [`Content-Type: ${multipartType()}`], body),
    )

    expect([response.status, response.body.toString()]).toEqual([
      200,
      JSON.stringify([
        ['kept.txt', 4],
        ['escaped.txt', 2],
        ['escaped-too.txt', 4],
      ]),
    ])
    expect(readdirSync(directory).sort()).toEqual(['escaped-too.txt', 'escaped.txt', 'kept.txt'])
    expect(statSync(join(directory, 'kept.txt')).size).toBe(4)
    expect(existsSync(join(directory, '..', 'escaped.txt'))).toBe(false)
    expect(existsSync(join(directory, '..', '..', 'escaped.txt'))).toBe(false)
    await expectHello(connection)
  })

  it.each(CONNECTION_CHOICES)(
    'answers 413 after the client sends a chunked upload above the limit, deletes the partial file, and %s',
    async (_choice, lines) => {
      const opened = Promise.withResolvers<void>()
      const server = await start(
        createApp()
          .post('/upload', { maxBodyBytes: MIB }, async c => {
            await c.req.body.multipart({
              file: file => {
                opened.resolve()
                return createWriteStream(join(directory, file.filename))
              },
            })
            return c.text('stored')
          })
          .get('/hello', c => c.text('Hello')),
      )
      const body = multipartBody([{ name: 'file', filename: 'large.bin', content: Buffer.alloc(4 * MIB, 7) }])

      const { connection, response } = await send(
        server.port,
        chunkedRequest('POST', '/upload', [`Content-Type: ${multipartType()}`, ...lines], piecesOf(body, 64)),
      )
      await opened.promise

      expect(response.status).toBe(413)
      expect(response.body.toString()).toBe(tooLarge(MIB))
      expect(readdirSync(directory)).toEqual([])
      await expectConnectionAfterReply(connection, lines)
    },
  )
})
