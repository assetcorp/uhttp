import { WriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { UhttpError } from '../errors.js'

/**
 * The package writes a file into a Node `Writable`, such as `fs.createWriteStream()`, or into a
 * web `WritableStream`.
 */
export type UploadStream = Writable | WritableStream<Uint8Array>

/**
 * Your `file` callback returns a stream for each file, or the stream together with a `discard`
 * function. When the upload fails, the package destroys every stream and then calls the `discard`
 * function of each destination that has one, such as a function that aborts a multipart upload to
 * object storage. For a stream from `fs.createWriteStream()` with a path and no `discard`
 * function, the package deletes the file itself.
 */
export type UploadDestination =
  | UploadStream
  | {
      /** The package writes the file into this stream. */
      readonly stream: UploadStream
      /** The package calls this function after it destroys the stream of a failed upload. */
      readonly discard?: () => void | Promise<void>
    }

/**
 * The package writes one file through this handle, whatever the kind of its destination.
 *
 * @internal
 */
export interface DestinationHandle {
  /** Writes a chunk, and the promise settles once the destination has drained. */
  write(bytes: Uint8Array): Promise<void>
  /** Ends the stream, and the promise settles once the destination has flushed every byte. */
  close(): Promise<void>
  /** Destroys the stream, waits for it to close, and then discards what it wrote. The promise never rejects. */
  destroy(error: Error): Promise<void>
}

type Discard = (() => void | Promise<void>) | undefined

function isNodeWritable(value: unknown): value is Writable {
  if (typeof value !== 'object' || value === null) return false
  return ['write', 'end', 'destroy', 'on', 'off'].every(method => typeof Reflect.get(value, method) === 'function')
}

function ignore(): void {
  return
}

function closedEarly(): UhttpError {
  return new UhttpError('INVALID_UPLOAD', 'The upload destination closed before it accepted the whole file.')
}

async function discardAll(stream: unknown, discard: Discard): Promise<void> {
  if (discard !== undefined) {
    await Promise.resolve().then(discard).catch(ignore)
    return
  }
  if (stream instanceof WriteStream && typeof stream.path === 'string')
    await rm(stream.path, { force: true }).catch(ignore)
}

function drained(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.off('drain', onDrain)
      stream.off('error', onError)
      stream.off('close', onClose)
    }
    const onDrain = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: unknown): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      reject(closedEarly())
    }
    stream.on('drain', onDrain)
    stream.on('error', onError)
    stream.on('close', onClose)
  })
}

function nodeHandle(stream: Writable, discard: Discard): DestinationHandle {
  let failure: unknown
  stream.on('error', error => {
    failure ??= error
  })
  const check = (): void => {
    if (failure !== undefined) throw failure
    if (stream.destroyed) throw closedEarly()
  }
  return {
    async write(bytes) {
      check()
      if (stream.write(bytes)) return
      await drained(stream)
    },
    async close() {
      check()
      stream.end()
      await finished(stream)
    },
    async destroy(error) {
      if (!stream.destroyed) stream.destroy(error)
      await finished(stream).catch(ignore)
      await discardAll(stream, discard)
    },
  }
}

function webHandle(stream: WritableStream<Uint8Array>, discard: Discard): DestinationHandle {
  const writer = stream.getWriter()
  return {
    async write(bytes) {
      await writer.ready
      await writer.write(bytes)
    },
    async close() {
      await writer.close()
    },
    async destroy(error) {
      void writer.abort(error).catch(ignore)
      await discardAll(stream, discard)
    },
  }
}

/**
 * Returns the handle through which the upload writes one file into the destination that your
 * `file` callback returned.
 *
 * @param destination - The package passes what the callback returned.
 * @returns The function returns the handle.
 * @throws {@link UhttpError} with the code `INVALID_UPLOAD` when the destination is neither a Node
 * `Writable`, nor a web `WritableStream`, nor an object with such a stream under `stream`.
 * @internal
 */
export function openDestination(destination: unknown): DestinationHandle {
  let stream: unknown = destination
  let discard: Discard
  if (typeof destination === 'object' && destination !== null && 'stream' in destination) {
    stream = Reflect.get(destination, 'stream')
    const candidate: unknown = Reflect.get(destination, 'discard')
    if (candidate !== undefined && typeof candidate !== 'function') {
      throw new UhttpError('INVALID_UPLOAD', 'Set the discard of an upload destination to a function.')
    }
    discard = typeof candidate === 'function' ? () => Reflect.apply(candidate, destination, []) : undefined
  }
  if (stream instanceof WritableStream) return webHandle(stream, discard)
  if (isNodeWritable(stream)) return nodeHandle(stream, discard)
  throw new UhttpError(
    'INVALID_UPLOAD',
    'Return a Node Writable, a web WritableStream, or an object with one of them under stream from the file callback of multipart().',
  )
}
