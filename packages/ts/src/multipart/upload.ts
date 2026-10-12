import { addField, type FormFields, type MediaType } from '../body/index.js'
import {
  DEFAULT_MAX_MULTIPART_FIELD_BYTES,
  DEFAULT_MAX_MULTIPART_PARTS,
  MAX_MULTIPART_BOUNDARY_LENGTH,
  MULTIPART_BOUNDARY_CHARACTERS,
} from '../constants.js'
import { UhttpError } from '../errors.js'
import type { Exchange } from '../exchange.js'
import { checkedLimit } from '../limits.js'
import { type DestinationHandle, openDestination, type UploadDestination } from './destination.js'
import { MultipartParser, type PartEvent } from './parser.js'

const BOUNDARY = new RegExp(
  `^[${MULTIPART_BOUNDARY_CHARACTERS} ]{0,${MAX_MULTIPART_BOUNDARY_LENGTH - 1}}[${MULTIPART_BOUNDARY_CHARACTERS}]$`,
)
const decoder = new TextDecoder()

/**
 * Your `file` callback receives these details of each file before its first byte.
 */
export interface UploadFile {
  /** The client sent the file under this field name. */
  readonly field: string
  /** The client sent this filename, of which the package keeps only the basename, so it can be empty. */
  readonly filename: string
  /** The client sent this content type for the file, which is `undefined` when it sent none. */
  readonly contentType: string | undefined
}

/**
 * `multipart()` returns each file in this shape once the package has written the whole file.
 */
export interface UploadedFile extends UploadFile {
  /** The file has this many bytes. */
  readonly size: number
  /** The package keeps the bytes of the file here when you pass no `file` callback, and `undefined` otherwise. */
  readonly bytes: Uint8Array | undefined
}

/**
 * You pass these options to `multipart()`. Every limit has a finite default, and once an upload
 * passes one of them, the package answers 413.
 */
export interface MultipartOptions {
  /**
   * The package calls this callback for each file and writes the file into the destination that
   * the callback returns. While the destination has a full buffer, the package waits for it to drain
   * before it reads more of the upload. Without the callback, the package keeps each file in memory.
   *
   * @param file - The package passes the field name, the filename, and the content type.
   * @returns The callback returns the destination, or a promise of it.
   */
  readonly file?: (file: UploadFile) => UploadDestination | Promise<UploadDestination>
  /** The body can have this many parts, fields and files together, which is 1,000 by default. */
  readonly maxParts?: number
  /** Each field value can take this many bytes, which is 1 MiB by default. */
  readonly maxFieldBytes?: number
  /** Each file can take this many bytes, which is the body limit of the route by default. */
  readonly maxFileBytes?: number
  /** The whole multipart body can take this many bytes, which is the body limit of the route by default. */
  readonly maxTotalBytes?: number
}

/**
 * `multipart()` returns the fields and the files of the form in this shape.
 */
export interface MultipartResult {
  /** The client sent these fields, with a list of values for a repeated name. */
  readonly fields: FormFields
  /** The client sent these files, in the order of the body. */
  readonly files: readonly UploadedFile[]
}

interface Limits {
  readonly parts: number
  readonly fieldBytes: number
  readonly fileBytes: number
  readonly totalBytes: number
}

interface OpenPart {
  readonly name: string
  readonly file: UploadFile | undefined
  readonly handle: DestinationHandle | undefined
  readonly chunks: Uint8Array[]
  size: number
}

function ignore(): void {
  return
}

function tooLarge(message: string): UhttpError {
  return new UhttpError('PAYLOAD_TOO_LARGE', message)
}

function limitOf(value: unknown, fallback: number, name: string): number {
  return value === undefined ? fallback : checkedLimit(value, 'INVALID_UPLOAD', name)
}

function limitsOf(options: MultipartOptions, maxBodyBytes: number): Limits {
  return {
    parts: limitOf(options.maxParts, DEFAULT_MAX_MULTIPART_PARTS, 'maxParts'),
    fieldBytes: limitOf(options.maxFieldBytes, DEFAULT_MAX_MULTIPART_FIELD_BYTES, 'maxFieldBytes'),
    fileBytes: limitOf(options.maxFileBytes, maxBodyBytes, 'maxFileBytes'),
    totalBytes: limitOf(options.maxTotalBytes, maxBodyBytes, 'maxTotalBytes'),
  }
}

class Upload {
  readonly fields: FormFields = Object.create(null)
  readonly files: UploadedFile[] = []
  readonly #limits: Limits
  readonly #fileCallback: MultipartOptions['file']
  readonly #handles: DestinationHandle[] = []
  readonly #released: Promise<never>
  #part: OpenPart | undefined
  #destroyed: Promise<void> | undefined
  #finished = false
  #releaseError: UhttpError | undefined
  #parts = 0
  #total = 0

  constructor(options: MultipartOptions, limits: Limits, exchange: Exchange) {
    if (options.file !== undefined && typeof options.file !== 'function') {
      throw new UhttpError('INVALID_UPLOAD', 'Pass a function as the file option of multipart().')
    }
    this.#fileCallback = options.file
    this.#limits = limits
    this.#released = new Promise<never>((_resolve, reject) => {
      exchange.onRelease(error => {
        if (this.#finished) return
        this.#releaseError = error
        reject(error)
        void this.destroyAll(error)
      })
    })
    this.#released.catch(ignore)
  }

  finish(): void {
    if (this.#releaseError !== undefined) throw this.#releaseError
    this.#finished = true
  }

  async run(body: AsyncIterable<Uint8Array>, parser: MultipartParser): Promise<void> {
    for await (const chunk of body) {
      this.#total += chunk.byteLength
      if (this.#total > this.#limits.totalBytes) {
        throw tooLarge(`The upload is larger than its limit of ${this.#limits.totalBytes} bytes.`)
      }
      const events: PartEvent[] = []
      parser.push(chunk, event => events.push(event))
      for (const event of events) await this.#handle(event)
    }
    parser.finish()
  }

  destroyAll(error: unknown): Promise<void> {
    if (this.#destroyed === undefined) {
      const reason = error instanceof Error ? error : new Error(String(error))
      this.#destroyed = Promise.all(this.#handles.map(handle => handle.destroy(reason))).then(ignore)
    }
    return this.#destroyed
  }

  #guard<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.#released])
  }

  async #handle(event: PartEvent): Promise<void> {
    if (event.kind === 'headers') {
      this.#parts++
      if (this.#parts > this.#limits.parts) throw tooLarge(`The upload has more than ${this.#limits.parts} parts.`)
      const { name, filename, contentType } = event.headers
      const file = filename === undefined ? undefined : { field: name, filename, contentType }
      const handle = file === undefined ? undefined : await this.#open(file)
      this.#part = { name, file, handle, chunks: [], size: 0 }
      return
    }
    const part = this.#part
    if (part === undefined) return
    if (event.kind === 'data') await this.#write(part, event.bytes)
    else await this.#close(part)
  }

  async #open(file: UploadFile): Promise<DestinationHandle | undefined> {
    const callback = this.#fileCallback
    if (callback === undefined) return undefined
    const pending = Promise.resolve().then(() => callback(file))
    let destination: UploadDestination
    try {
      destination = await this.#guard(pending)
    } catch (error) {
      void pending.then(late => openDestination(late).destroy(new Error('The upload failed.')), ignore).catch(ignore)
      throw error
    }
    const handle = openDestination(destination)
    if (this.#destroyed !== undefined) {
      await handle.destroy(new Error('The upload failed.'))
      throw new UhttpError('REQUEST_ABORTED', 'The upload ended before this file began.')
    }
    this.#handles.push(handle)
    return handle
  }

  async #write(part: OpenPart, bytes: Uint8Array): Promise<void> {
    part.size += bytes.byteLength
    const limit = part.file === undefined ? this.#limits.fieldBytes : this.#limits.fileBytes
    if (part.size > limit) {
      const kind = part.file === undefined ? 'field' : 'file'
      throw tooLarge(`A ${kind} in the upload is larger than its limit of ${limit} bytes.`)
    }
    if (part.handle === undefined) part.chunks.push(bytes)
    else await this.#guard(part.handle.write(bytes))
  }

  async #close(part: OpenPart): Promise<void> {
    this.#part = undefined
    const whole = part.handle === undefined ? Buffer.concat(part.chunks, part.size) : undefined
    if (part.file === undefined) {
      addField(this.fields, part.name, decoder.decode(whole))
      return
    }
    if (part.handle !== undefined) await this.#guard(part.handle.close())
    this.files.push({ ...part.file, size: part.size, bytes: whole })
  }
}

/**
 * Returns the fields and the files of a multipart body. On any failure, the function destroys every
 * destination and discards every file that it wrote before it throws.
 *
 * @param body - The package passes the stream of the request body.
 * @param mediaType - The package passes the parsed content type, with the boundary among its parameters.
 * @param options - The handler passes the `file` callback and the limits.
 * @param maxBodyBytes - The package passes the body limit of the route, which is the default file and upload limit.
 * @param exchange - The package passes the state of the request, which releases the upload.
 * @returns The promise resolves to the fields and the files.
 * @throws {@link UhttpError} with the code `INVALID_MULTIPART`, `PAYLOAD_TOO_LARGE`, or
 * `INVALID_UPLOAD`, or with the error that released the request.
 * @internal
 */
export async function readMultipart(
  body: AsyncIterable<Uint8Array>,
  mediaType: MediaType,
  options: MultipartOptions,
  maxBodyBytes: number,
  exchange: Exchange,
): Promise<MultipartResult> {
  const boundary = mediaType.parameters.boundary
  if (boundary === undefined || !BOUNDARY.test(boundary)) {
    throw new UhttpError(
      'INVALID_MULTIPART',
      `Send a boundary of 1 to ${MAX_MULTIPART_BOUNDARY_LENGTH} characters from the RFC 2046 alphabet.`,
    )
  }
  const upload = new Upload(options, limitsOf(options, maxBodyBytes), exchange)
  try {
    await upload.run(body, new MultipartParser(boundary))
    upload.finish()
  } catch (error) {
    await upload.destroyAll(error)
    throw error
  }
  return { fields: upload.fields, files: upload.files }
}
