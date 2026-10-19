import { UhttpError } from '../errors.js'
import type { Exchange } from '../exchange.js'
import type { MultipartOptions, MultipartResult } from '../multipart/index.js'
import { type FormFields, parseForm } from './form.js'
import { parseJson } from './json.js'
import { isJsonType, type MediaType, parseMediaType } from './media-type.js'
import type { BodyReader } from './reader.js'
import { type StandardSchemaV1, validated } from './schema.js'

const UTF_8 = 'utf-8'
const FORM_TYPE = 'application/x-www-form-urlencoded'
const MULTIPART_TYPE = 'multipart/form-data'

/**
 * You read the body of a request through `c.req.body`. A route has a body reader when its method
 * is POST, PUT, or PATCH, or when it sets `body: true`. Every method enforces the body limit of the
 * route. The package keeps the bytes of a body that a parser has read, so you can read that body
 * again, but once you stream a body that no parser has read, every later read throws.
 */
export interface RequestBody {
  /**
   * Returns the body as an async iterable of byte chunks, which the package copies out of the
   * memory of uWebSockets.js. The package pauses the upload once it holds 64 KiB that your code
   * hasn't read. After a parser has read the body, the iterable yields the kept bytes as one chunk.
   *
   * @returns The iterable yields the chunks in the order that the client sent them.
   * @throws {@link UhttpError} with the code `PAYLOAD_TOO_LARGE` once the body passes the limit of the
   * route, `REQUEST_ABORTED` when the client disconnects, `UNDECLARED_BODY` on a route without a
   * body reader, or `BODY_ALREADY_READ` after an earlier stream of the body.
   */
  stream(): AsyncIterable<Uint8Array>
  /**
   * Returns the whole body as bytes, whatever its content type.
   *
   * @returns The promise resolves to the bytes of the body.
   * @throws {@link UhttpError} with the code `PAYLOAD_TOO_LARGE` once the body passes the limit of the
   * route, `REQUEST_ABORTED` when the client disconnects, `UNDECLARED_BODY` on a route without a
   * body reader, or `BODY_ALREADY_READ` after a stream of the body.
   */
  bytes(): Promise<Uint8Array>
  /**
   * Returns the body as text in the charset of its `text/*` content type, which is UTF-8 when the
   * content type has no charset.
   *
   * @returns The promise resolves to the decoded text.
   * @throws {@link UhttpError} with the code `UNSUPPORTED_MEDIA_TYPE` for another content type or for
   * a charset that Node can't decode.
   */
  text(): Promise<string>
  /**
   * Returns the parsed body of a request whose content type is `application/json` or ends in
   * `+json`.
   *
   * @returns The promise resolves to the parsed value.
   * @throws {@link UhttpError} with the code `UNSUPPORTED_MEDIA_TYPE` for another content type or a
   * charset other than UTF-8, or `INVALID_JSON` when the method can't parse the body or the body
   * contains a `__proto__` key or a `constructor` key with a `prototype` key.
   */
  json(): Promise<unknown>
  /**
   * Returns the output of a schema for the parsed JSON body. The schema can come from any validator
   * that implements Standard Schema v1, such as Valibot, Zod, or ArkType.
   *
   * @param schema - You pass the schema that the body must match.
   * @returns The promise resolves to the output of the schema.
   * @throws {@link UhttpError} with any code that `json()` throws without a schema, with
   * `VALIDATION_FAILED` and the first 10 problems when the schema rejects the body, or with
   * `INVALID_SCHEMA` when the validator throws, rejects, or returns something other than a Standard
   * Schema result.
   */
  json<Schema extends StandardSchemaV1>(schema: Schema): Promise<StandardSchemaV1.InferOutput<Schema>>
  /**
   * Returns the fields of an `application/x-www-form-urlencoded` body as a flat map, with no
   * bracket or dot nesting.
   *
   * @returns The promise resolves to the fields.
   * @throws {@link UhttpError} with the code `UNSUPPORTED_MEDIA_TYPE` for another content type, or
   * `PAYLOAD_TOO_LARGE` once the body passes 1,000 parameters.
   */
  form(): Promise<FormFields>
  /**
   * Returns the fields and the files of a `multipart/form-data` body. The package streams each file
   * to the destination that your `file` callback returns, or keeps it in memory when you pass no
   * callback.
   *
   * @param options - You can pass the `file` callback and the limits of the upload here.
   * @returns The promise resolves to the fields and the files once the package has written every
   * file.
   * @throws {@link UhttpError} with the code `UNSUPPORTED_MEDIA_TYPE` for another content type,
   * `INVALID_MULTIPART` for a malformed body, `PAYLOAD_TOO_LARGE` once the upload passes a limit,
   * or `INVALID_UPLOAD` for an invalid option or destination. On any failure, the package destroys
   * every destination first.
   */
  multipart(options?: MultipartOptions): Promise<MultipartResult>
}

function unsupported(message: string): UhttpError {
  return new UhttpError('UNSUPPORTED_MEDIA_TYPE', message)
}

function decoderFor(charset: string | undefined): InstanceType<typeof TextDecoder> {
  try {
    return new TextDecoder(charset ?? UTF_8)
  } catch {
    throw unsupported(`The server can't decode the charset '${charset}'.`)
  }
}

async function* replay(bytes: Promise<Uint8Array>): AsyncGenerator<Uint8Array> {
  const whole = await bytes
  if (whole.byteLength > 0) yield whole
}

async function* chunksOf(reader: BodyReader): AsyncGenerator<Uint8Array> {
  while (true) {
    const chunk = await reader.read()
    if (chunk === undefined) return
    yield chunk
  }
}

async function collect(reader: BodyReader): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of chunksOf(reader)) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  return chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : Buffer.concat(chunks, total)
}

/**
 * The package creates this body for each request on the first read of `c.req.body`.
 *
 * @internal
 */
export class ReaderBody implements RequestBody {
  readonly #reader: BodyReader | undefined
  readonly #contentType: string | undefined
  readonly #exchange: Exchange
  #streamed = false
  #bytes: Promise<Uint8Array> | undefined

  /**
   * Creates the body of one request.
   *
   * @param exchange - The package passes the state of the request.
   * @param reader - The package passes the body reader, which is `undefined` on a route without one.
   * @param contentType - The package passes the `content-type` header that the client sent.
   */
  constructor(exchange: Exchange, reader: BodyReader | undefined, contentType: string | undefined) {
    this.#exchange = exchange
    this.#reader = reader
    this.#contentType = contentType
  }

  stream(): AsyncIterable<Uint8Array> {
    const reader = this.#claimed()
    if (this.#bytes !== undefined) return replay(this.#bytes)
    if (this.#streamed) throw new UhttpError('BODY_ALREADY_READ', 'Your code has already streamed this body.')
    this.#streamed = true
    return chunksOf(reader)
  }

  async bytes(): Promise<Uint8Array> {
    const reader = this.#claimed()
    if (this.#bytes === undefined) {
      if (this.#streamed) throw new UhttpError('BODY_ALREADY_READ', 'Your code has already streamed this body.')
      this.#bytes = collect(reader)
    }
    return this.#bytes
  }

  async text(): Promise<string> {
    const mediaType = this.#mediaType()
    if (mediaType === undefined || !mediaType.type.startsWith('text/')) {
      throw unsupported('Send a text/* content type to this route.')
    }
    const decoder = decoderFor(mediaType.parameters.charset)
    return decoder.decode(await this.bytes())
  }

  json(): Promise<unknown>
  json<Schema extends StandardSchemaV1>(schema: Schema): Promise<StandardSchemaV1.InferOutput<Schema>>
  async json(schema?: StandardSchemaV1): Promise<unknown> {
    const mediaType = this.#mediaType()
    if (!isJsonType(mediaType)) throw unsupported('Send an application/json content type to this route.')
    if (decoderFor(mediaType?.parameters.charset).encoding !== UTF_8) {
      throw unsupported('Send a JSON body in UTF-8, as RFC 8259 requires.')
    }
    const value = parseJson(new TextDecoder().decode(await this.bytes()))
    return schema === undefined ? value : validated(schema, value)
  }

  async form(): Promise<FormFields> {
    if (this.#mediaType()?.type !== FORM_TYPE) throw unsupported(`Send a ${FORM_TYPE} content type to this route.`)
    return parseForm(new TextDecoder().decode(await this.bytes()))
  }

  async multipart(options: MultipartOptions = {}): Promise<MultipartResult> {
    const mediaType = this.#mediaType()
    if (mediaType?.type !== MULTIPART_TYPE) throw unsupported(`Send a ${MULTIPART_TYPE} content type to this route.`)
    const limit = this.#claimed().limit
    const { readMultipart } = await import('../multipart/index.js')
    return readMultipart(this.stream(), mediaType, options, limit, this.#exchange)
  }

  #mediaType(): MediaType | undefined {
    this.#claimed()
    return parseMediaType(this.#contentType)
  }

  #claimed(): BodyReader {
    if (this.#reader === undefined) {
      throw new UhttpError(
        'UNDECLARED_BODY',
        'Set body to true on the route before you read the body, because the package attaches a body reader only on POST, PUT, and PATCH routes by default.',
      )
    }
    return this.#reader
  }
}
