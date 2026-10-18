import type { Stats } from 'node:fs'
import { UhttpError } from '../../errors.js'
import type { StreamProducer } from '../../reply.js'
import { STATIC_READ_CHUNK_BYTES } from './constants.js'
import { reopen } from './locate.js'

/**
 * Returns a stream producer that sends a part of a file. The producer opens the file when the
 * package starts to send the body, so that the process opens no descriptor for a reply that the
 * package never sends. It loads one chunk at a time, and it loads the next chunk only once the
 * package has written the last one to the socket. It stops and closes the file once the client
 * disconnects.
 *
 * @param path - The middleware passes the real path of the file.
 * @param stats - The middleware passes the details of the file on which it based the headers.
 * @param start - The middleware passes the first byte to send.
 * @param length - The middleware passes the number of bytes to send.
 * @returns The function returns the producer.
 * @internal
 */
export function fileProducer(path: string, stats: Stats, start: number, length: number): StreamProducer {
  return async stream => {
    if (length === 0 || stream.closed) return
    const handle = await reopen(path, stats)
    try {
      let position = start
      let remaining = length
      while (remaining > 0 && !stream.closed) {
        const size = Math.min(STATIC_READ_CHUNK_BYTES, remaining)
        const buffer = Buffer.allocUnsafe(size)
        const { bytesRead } = await handle.read(buffer, 0, size, position)
        if (bytesRead === 0) {
          throw new UhttpError('INTERNAL_ERROR', 'The file ended before the length that the response declared.')
        }
        position += bytesRead
        remaining -= bytesRead
        if (!(await stream.write(buffer.subarray(0, bytesRead)))) return
      }
    } finally {
      await handle.close()
    }
  }
}
