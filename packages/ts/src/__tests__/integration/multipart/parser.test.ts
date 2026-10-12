import { describe, expect, it } from 'vitest'
import { createApp, type MultipartOptions } from '../../../index.js'
import { BOUNDARY, errorCodeOf, forEverySplit, multipartBody, multipartType, splitAt } from '../../helpers/body.js'

interface Summary {
  fields: Record<string, string | string[]>
  files: { field: string; filename: string; contentType?: string; size: number; text?: string }[]
}

function summaryApp(options: MultipartOptions = {}, routeLimit?: number) {
  const routeOptions = routeLimit === undefined ? {} : { maxBodyBytes: routeLimit }
  return createApp().post('/upload', routeOptions, async c => {
    const { fields, files } = await c.req.body.multipart(options)
    return c.json({
      fields,
      files: files.map(file => ({
        field: file.field,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        text: file.bytes === undefined ? undefined : Buffer.from(file.bytes).toString(),
      })),
    })
  })
}

async function expectAtEverySplit(
  body: Uint8Array,
  expected: (summary: Summary) => void,
  options: MultipartOptions = {},
): Promise<void> {
  await forEverySplit(summaryApp(options), '/upload', body, multipartType(), async (response, position) => {
    expect(response.status, `split at byte ${position}`).toBe(200)
    expected((await response.json()) as Summary)
  })
}

async function expectRefusalAtEverySplit(
  body: Uint8Array,
  status: number,
  code: string,
  options: MultipartOptions = {},
  contentType = multipartType(),
): Promise<void> {
  await forEverySplit(summaryApp(options), '/upload', body, contentType, async (response, position) => {
    expect(response.status, `split at byte ${position}`).toBe(status)
    expect(await errorCodeOf(response)).toBe(code)
  })
}

describe('multipart() split at every byte position', () => {
  it('parses fields and in-memory files wherever the chunks break', async () => {
    const body = multipartBody([
      { name: 'title', value: 'Harmattan notes' },
      { name: 'tag', value: 'weather' },
      { name: 'tag', value: 'accra' },
      { name: 'report', filename: 'notes.txt', contentType: 'text/plain', content: 'dry wind\r\n--not a boundary' },
    ])

    await expectAtEverySplit(body, summary => {
      expect(summary.fields).toEqual({ title: 'Harmattan notes', tag: ['weather', 'accra'] })
      expect(summary.files).toEqual([
        {
          field: 'report',
          filename: 'notes.txt',
          contentType: 'text/plain',
          size: 26,
          text: 'dry wind\r\n--not a boundary',
        },
      ])
    })
  })

  it('treats a boundary followed by other bytes as file content', async () => {
    const content = `before\r\n--${BOUNDARY}x after`
    const body = multipartBody([{ name: 'f', filename: 'a.txt', content }])

    await expectAtEverySplit(body, summary => {
      expect(summary.files[0]?.text).toBe(content)
    })
  })

  it('ignores a preamble and an epilogue', async () => {
    const inner = multipartBody([{ name: 'a', value: '1' }])
    const body = Buffer.concat([Buffer.from('preamble text\r\n'), inner, Buffer.from('epilogue')])

    await expectAtEverySplit(body, summary => {
      expect(summary.fields).toEqual({ a: '1' })
    })
  })

  it('keeps only the basename of a filename', async () => {
    const body = multipartBody([
      { name: 'a', filename: '../../etc/passwd', content: 'x' },
      { name: 'b', filename: 'C:\\Users\\ama\\photo.jpg', content: 'y' },
      { name: 'c', filename: '..', content: 'z' },
      { name: 'd', filename: 'uploads/.', content: 'w' },
    ])

    await expectAtEverySplit(body, summary => {
      expect(summary.files.map(file => file.filename)).toEqual(['passwd', 'photo.jpg', '', ''])
    })
  })

  it('keeps part headers named __proto__ or constructor as ordinary headers', async () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\n__proto__: {"polluted":true}\r\nConstructor: x\r\nContent-Disposition: form-data; name="a"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nv\r\n--${BOUNDARY}--\r\n`,
    )

    await expectAtEverySplit(body, summary => {
      expect(summary.files[0]?.contentType).toBe('text/plain')
      expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
    })
  })

  it('answers 400 with INVALID_MULTIPART for a control character in a name or a filename', async () => {
    for (const entry of [
      { name: 'bad\u0001name', value: 'v' },
      { name: 'f', filename: 'evil\u0007.txt', content: 'x' },
    ]) {
      await expectRefusalAtEverySplit(multipartBody([entry]), 400, 'INVALID_MULTIPART')
    }
  })

  it('answers 400 for a body that ends before its closing boundary', async () => {
    const full = multipartBody([{ name: 'a', value: '1' }])
    const truncated = full.subarray(0, full.byteLength - 8)

    await expectRefusalAtEverySplit(truncated, 400, 'INVALID_MULTIPART')
  })

  it('answers 400 for a part without a form-data name', async () => {
    const body = Buffer.from(`--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nvalue\r\n--${BOUNDARY}--\r\n`)

    await expectRefusalAtEverySplit(body, 400, 'INVALID_MULTIPART')
  })

  it('answers 413 once the parts pass the part limit', async () => {
    const body = multipartBody([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
      { name: 'c', value: '3' },
    ])

    await expectRefusalAtEverySplit(body, 413, 'PAYLOAD_TOO_LARGE', { maxParts: 2 })
  })

  it('answers 413 for a field above its limit and a file above its limit', async () => {
    await expectRefusalAtEverySplit(multipartBody([{ name: 'a', value: '123456' }]), 413, 'PAYLOAD_TOO_LARGE', {
      maxFieldBytes: 5,
    })
    await expectRefusalAtEverySplit(
      multipartBody([{ name: 'f', filename: 'f.bin', content: '123456' }]),
      413,
      'PAYLOAD_TOO_LARGE',
      { maxFileBytes: 5 },
    )
  })

  it('answers 413 once the whole upload passes its limit', async () => {
    const body = multipartBody([
      { name: 'f', filename: 'one.bin', content: 'x'.repeat(40) },
      { name: 'g', filename: 'two.bin', content: 'y'.repeat(40) },
    ])

    await expectRefusalAtEverySplit(body, 413, 'PAYLOAD_TOO_LARGE', { maxTotalBytes: 150 })
  })

  it('answers 413 for a field name longer than 256 bytes and for more than 16 part headers', async () => {
    await expectRefusalAtEverySplit(multipartBody([{ name: 'n'.repeat(257), value: 'v' }]), 413, 'PAYLOAD_TOO_LARGE')
    const headers = Array.from({ length: 17 }, (_, index) => `X-Extra-${index}: 1\r\n`).join('')
    const crowded = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n${headers}\r\nv\r\n--${BOUNDARY}--\r\n`,
    )
    await expectRefusalAtEverySplit(crowded, 413, 'PAYLOAD_TOO_LARGE')
  })

  it('defaults the file limit and the upload limit to the body limit of the route', async () => {
    const app = summaryApp({}, 1_000)
    const body = multipartBody([{ name: 'f', filename: 'f.bin', content: 'z'.repeat(2_000) }])

    const response = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-type': multipartType() },
      body: splitAt(body, 500),
    })

    expect(response.status).toBe(413)
  })
})

describe('the boundary of a multipart body', () => {
  async function statusFor(contentType: string): Promise<number> {
    const response = await summaryApp().request('/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: multipartBody([{ name: 'a', value: '1' }], 'b'),
    })
    return response.status
  }

  it('accepts a boundary of 1 to 70 characters from the RFC 2046 alphabet', async () => {
    for (const boundary of ['b', `${"a'()+_,-./:=? ".repeat(4)}${'a'.repeat(13)}z`]) {
      const body = multipartBody([{ name: 'a', value: '1' }], boundary)
      const contentType = `multipart/form-data; boundary="${boundary}"`
      await forEverySplit(summaryApp(), '/upload', body, contentType, async (response, position) => {
        expect(response.status, `boundary of ${boundary.length}, split at byte ${position}`).toBe(200)
        expect(((await response.json()) as Summary).fields).toEqual({ a: '1' })
      })
    }

    expect(await statusFor(`multipart/form-data; boundary=${'b'.repeat(71)}`)).toBe(400)
    expect(await statusFor('multipart/form-data; boundary="b@"')).toBe(400)
    expect(await statusFor('multipart/form-data; boundary="b "')).toBe(400)
    expect(await statusFor('multipart/form-data')).toBe(400)
  })

  it('answers 415 for a content type other than multipart/form-data', async () => {
    expect(await statusFor('application/json')).toBe(415)
  })
})
