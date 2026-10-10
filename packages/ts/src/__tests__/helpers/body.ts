import type { App } from '../../index.js'

export const BOUNDARY = 'uhttp-boundary-7MA4YWxkTrZu0gW'

export interface MultipartField {
  name: string
  value: string
}

export interface MultipartFile {
  name: string
  filename: string
  contentType?: string
  content: string | Uint8Array
}

export type MultipartEntry = MultipartField | MultipartFile

function isFile(entry: MultipartEntry): entry is MultipartFile {
  return 'filename' in entry
}

export function multipartBody(entries: readonly MultipartEntry[], boundary = BOUNDARY): Uint8Array {
  const pieces: Uint8Array[] = []
  const text = (value: string) => pieces.push(Buffer.from(value))
  for (const entry of entries) {
    text(`--${boundary}\r\n`)
    if (isFile(entry)) {
      text(`Content-Disposition: form-data; name="${entry.name}"; filename="${entry.filename}"\r\n`)
      text(`Content-Type: ${entry.contentType ?? 'application/octet-stream'}\r\n\r\n`)
      pieces.push(typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content)
    } else {
      text(`Content-Disposition: form-data; name="${entry.name}"\r\n\r\n${entry.value}`)
    }
    text('\r\n')
  }
  text(`--${boundary}--\r\n`)
  return Buffer.concat(pieces)
}

export function multipartType(boundary = BOUNDARY): string {
  return `multipart/form-data; boundary=${boundary}`
}

export function splitAt(bytes: Uint8Array, position: number): Uint8Array[] {
  return [bytes.subarray(0, position), bytes.subarray(position)]
}

export async function forEverySplit(
  app: App,
  path: string,
  body: Uint8Array,
  contentType: string,
  check: (response: Response, position: number) => Promise<void>,
): Promise<void> {
  for (let position = 1; position < body.byteLength; position++) {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: splitAt(body, position),
    })
    await check(response, position)
  }
}

export async function errorCodeOf(response: Response): Promise<string> {
  const payload = (await response.json()) as { error: { code: string } }
  return payload.error.code
}
