import * as zlib from 'node:zlib'
import type { ResponseStream, StreamProducer } from '../../reply.js'
import { BROTLI_QUALITY } from './constants.js'

/**
 * The middleware compresses a body with one of these encodings.
 */
export type CompressionEncoding = 'br' | 'zstd' | 'gzip'

type Compressor = ReturnType<typeof zlib.createGzip> | ReturnType<typeof zlib.createBrotliCompress>

/**
 * Returns `true` when this version of Node can compress with an encoding.
 *
 * @param encoding - The middleware passes the encoding.
 * @returns The function returns `false` for zstd on a version of Node without it.
 * @internal
 */
export function encodingAvailable(encoding: CompressionEncoding): boolean {
  return encoding !== 'zstd' || typeof zlib.zstdCompress === 'function'
}

function brotliParameters(sizeHint: number): Record<number, number> {
  return {
    [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: sizeHint,
  }
}

/**
 * Returns a whole body that Node compresses on its thread pool, so that the package can serve other
 * requests in the meantime.
 *
 * @param encoding - The middleware passes the encoding.
 * @param body - The middleware passes the bytes of the body.
 * @returns The function returns a promise of the compressed bytes.
 * @internal
 */
export function compressBody(encoding: CompressionEncoding, body: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer): void => {
      if (error === null) resolve(result)
      else reject(error)
    }
    if (encoding === 'br') zlib.brotliCompress(body, { params: brotliParameters(body.byteLength) }, done)
    else if (encoding === 'zstd') zlib.zstdCompress(body, done)
    else zlib.gzip(body, done)
  })
}

function ignore(): void {
  return
}

function compressorFor(encoding: CompressionEncoding): Compressor {
  if (encoding === 'br') return zlib.createBrotliCompress({ params: brotliParameters(0) })
  if (encoding === 'zstd') return zlib.createZstdCompress()
  return zlib.createGzip()
}

/**
 * Returns a stream producer that passes everything that another producer writes through a
 * compressor. Each write of the inner producer resolves once the package has passed the compressed
 * bytes before it to the socket, so that a slow client slows the producer down. The function stops
 * the compressor when the client disconnects.
 *
 * @param produce - The middleware passes the producer of the reply.
 * @param encoding - The middleware passes the encoding.
 * @returns The function returns the compressing producer.
 * @internal
 */
export function compressedProducer(produce: StreamProducer, encoding: CompressionEncoding): StreamProducer {
  return async out => {
    const compressor = compressorFor(encoding)
    let forwarded: Promise<boolean> = Promise.resolve(true)
    compressor.on('data', (chunk: Buffer) => {
      forwarded = forwarded.then(open => (open ? out.write(chunk) : false))
    })
    const finished = new Promise<void>((resolve, reject) => {
      compressor.once('end', resolve)
      compressor.once('close', resolve)
      compressor.once('error', reject)
    })
    finished.catch(ignore)
    out.onClose(() => compressor.destroy())
    const proxy: ResponseStream = {
      write(chunk) {
        if (out.closed) return Promise.resolve(false)
        return new Promise((resolve, reject) => {
          compressor.write(chunk, error => {
            if (error === undefined || error === null) resolve(forwarded)
            else if (out.closed) resolve(false)
            else reject(error)
          })
        })
      },
      onClose(listener) {
        out.onClose(listener)
      },
      get closed() {
        return out.closed
      },
    }
    try {
      await produce(proxy)
    } catch (error) {
      compressor.destroy()
      throw error
    }
    if (out.closed) return
    compressor.end()
    await finished
    await forwarded
  }
}
