const CRLF = Buffer.from('\r\n')
const STATUS_LINE = /^HTTP\/1\.1 ([1-5]\d\d) ([\t\x20-\x7e\x80-\xff]*)$/
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/
const OPTIONAL_WHITESPACE = /^[\t ]+|[\t ]+$/g
const CHUNK_SIZE_LINE = /^([0-9A-Fa-f]{1,8})(?:;[\t\x20-\x7e]*)?$/
const DIGITS = /^\d+$/

export type BodyFraming = 'none' | 'length' | 'chunked' | 'close'

export interface ReceivedResponse {
  status: number
  headers: Map<string, string[]>
  body: Buffer
  framing: BodyFraming
  trailers: Map<string, string[]>
  interim: number[]
}

export interface ResponseHead {
  status: number
  headers: Map<string, string[]>
  next: number
}

interface Fields {
  fields: Map<string, string[]>
  next: number
}

interface Content {
  body: Buffer
  trailers: Map<string, string[]>
  next: number
}

interface ParsedResponse {
  response: ReceivedResponse
  consumed: number
}

function readLine(data: Buffer, offset: number): { line: string; next: number } | undefined {
  const end = data.indexOf(CRLF, offset)
  if (end === -1) return undefined
  return { line: data.subarray(offset, end).toString('latin1'), next: end + CRLF.length }
}

function readFields(data: Buffer, offset: number): Fields | undefined {
  const fields = new Map<string, string[]>()
  let cursor = offset
  while (true) {
    const read = readLine(data, cursor)
    if (read === undefined) return undefined
    cursor = read.next
    if (read.line === '') return { fields, next: cursor }
    const colon = read.line.indexOf(':')
    const name = read.line.slice(0, Math.max(colon, 0))
    if (!FIELD_NAME.test(name)) throw new Error(`The server sent the malformed field line '${read.line}'.`)
    const value = read.line.slice(colon + 1).replace(OPTIONAL_WHITESPACE, '')
    if (!FIELD_VALUE.test(value)) throw new Error(`The server sent the malformed field value in '${read.line}'.`)
    const key = name.toLowerCase()
    fields.set(key, [...(fields.get(key) ?? []), value])
  }
}

export function readHead(data: Buffer, offset: number): ResponseHead | undefined {
  const statusRead = readLine(data, offset)
  if (statusRead === undefined) return undefined
  const match = STATUS_LINE.exec(statusRead.line)
  if (match === null) throw new Error(`The server sent the malformed status line '${statusRead.line}'.`)
  const fields = readFields(data, statusRead.next)
  if (fields === undefined) return undefined
  return { status: Number(match[1]), headers: fields.fields, next: fields.next }
}

function framingOf(status: number, headers: Map<string, string[]>, method: string): BodyFraming {
  const codings = headers.get('transfer-encoding')
  const lengths = headers.get('content-length')
  if ((status < 200 || status === 204) && (codings !== undefined || lengths !== undefined)) {
    throw new Error(`The server sent Content-Length or Transfer-Encoding with a ${status}.`)
  }
  if (codings !== undefined && lengths !== undefined) {
    throw new Error('The server sent both Content-Length and Transfer-Encoding.')
  }
  if (lengths !== undefined && (lengths.length !== 1 || !DIGITS.test(lengths[0] ?? ''))) {
    throw new Error(`The server sent the Content-Length lines ${JSON.stringify(lengths)}.`)
  }
  if (status < 200 || status === 204 || status === 304 || method === 'HEAD') return 'none'
  if (codings !== undefined) {
    const list = codings
      .join(',')
      .split(',')
      .map(coding => coding.trim().toLowerCase())
    if (list.filter(coding => coding === 'chunked').length > 1) {
      throw new Error(`The server sent chunked more than once in '${codings.join(', ')}'.`)
    }
    return list.at(-1) === 'chunked' ? 'chunked' : 'close'
  }
  return lengths === undefined ? 'close' : 'length'
}

function readChunked(data: Buffer, offset: number): Content | undefined {
  const parts: Buffer[] = []
  let cursor = offset
  while (true) {
    const read = readLine(data, cursor)
    if (read === undefined) return undefined
    const match = CHUNK_SIZE_LINE.exec(read.line)
    if (match === null) throw new Error(`The server sent '${read.line}' where a chunk size belongs.`)
    const size = Number.parseInt(match[1] ?? '', 16)
    if (size === 0) {
      const trailer = readFields(data, read.next)
      if (trailer === undefined) return undefined
      return { body: Buffer.concat(parts), trailers: trailer.fields, next: trailer.next }
    }
    const end = read.next + size
    if (data.length < end + CRLF.length) return undefined
    if (!data.subarray(end, end + CRLF.length).equals(CRLF)) {
      throw new Error(`The server sent more than the ${size} bytes that its chunk size declares.`)
    }
    parts.push(data.subarray(read.next, end))
    cursor = end + CRLF.length
  }
}

function readContent(
  data: Buffer,
  offset: number,
  framing: BodyFraming,
  headers: Map<string, string[]>,
  ended: boolean,
): Content | undefined {
  if (framing === 'chunked') return readChunked(data, offset)
  if (framing === 'none') return { body: Buffer.alloc(0), trailers: new Map(), next: offset }
  if (framing === 'close') {
    return ended ? { body: data.subarray(offset), trailers: new Map(), next: data.length } : undefined
  }
  const next = offset + Number(headers.get('content-length')?.[0])
  return data.length < next ? undefined : { body: data.subarray(offset, next), trailers: new Map(), next }
}

export function parseResponse(data: Buffer, method: string, ended: boolean): ParsedResponse | undefined {
  const interim: number[] = []
  let cursor = 0
  while (true) {
    const head = readHead(data, cursor)
    if (head === undefined) return undefined
    cursor = head.next
    const framing = framingOf(head.status, head.headers, method)
    if (head.status < 200 && head.status !== 101) {
      interim.push(head.status)
      continue
    }
    const content = readContent(data, cursor, framing, head.headers, ended)
    if (content === undefined) return undefined
    const { status, headers } = head
    const { body, trailers, next } = content
    return { response: { status, headers, body, framing, trailers, interim }, consumed: next }
  }
}
