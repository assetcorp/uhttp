const MILLISECONDS_PER_SECOND = 1000
const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/i

/**
 * The middleware replies to a `Range` header with the whole file, with one part of it, or with a
 * 416.
 *
 * @internal
 */
export type ByteRange =
  | { readonly kind: 'whole' }
  | { readonly kind: 'part'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' }

/**
 * Returns the weak entity tag of a file, built from its size and its modification time in
 * milliseconds, both in hex.
 *
 * @param size - The middleware passes the size of the file in bytes.
 * @param modifiedMs - The middleware passes the modification time of the file.
 * @returns The function returns the tag, such as `W/"14-19bc1b9c4d2"`.
 * @internal
 */
export function entityTag(size: number, modifiedMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(modifiedMs).toString(16)}"`
}

/**
 * Returns `true` when an `If-None-Match` header matches an entity tag under the weak comparison of
 * RFC 9110, so the function drops the `W/` of either tag before it compares them.
 *
 * @param header - The middleware passes the header of the request.
 * @param tag - The middleware passes the tag of the file.
 * @returns The function returns `true` for `*` or for a list that contains the tag.
 * @internal
 */
export function matchesNoneMatch(header: string, tag: string): boolean {
  if (header.trim() === '*') return true
  const opaque = tag.startsWith('W/') ? tag.slice(2) : tag
  for (const entry of header.split(',')) {
    const candidate = entry.trim()
    if ((candidate.startsWith('W/') ? candidate.slice(2) : candidate) === opaque) return true
  }
  return false
}

/**
 * Returns `true` when a file has not changed since the date of an `If-Modified-Since` header. The
 * function drops the milliseconds of the modification time before it compares, because an HTTP
 * date has whole seconds alone.
 *
 * @param header - The middleware passes the header of the request.
 * @param modifiedMs - The middleware passes the modification time of the file.
 * @returns The function returns `false` for a date that fails to parse.
 * @internal
 */
export function unmodifiedSince(header: string, modifiedMs: number): boolean {
  const since = Date.parse(header)
  if (Number.isNaN(since)) return false
  return Math.floor(modifiedMs / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND <= since
}

/**
 * Returns the byte range that the client asks for in a `Range` header. The function returns one
 * range of the `bytes` unit, and it returns the whole file for several ranges, for another unit,
 * or for a malformed header, as RFC 9110 allows.
 *
 * @param header - The middleware passes the header of the request.
 * @param size - The middleware passes the size of the file in bytes.
 * @returns The function returns `unsatisfiable` for a range that starts at or past the end of the
 * file and for a suffix of zero bytes.
 * @internal
 */
export function byteRange(header: string | undefined, size: number): ByteRange {
  const match = header === undefined ? null : BYTE_RANGE.exec(header)
  if (match === null) return { kind: 'whole' }
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return { kind: 'whole' }
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'part', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (last !== '' && Number(last) < start) return { kind: 'whole' }
  if (start >= size) return { kind: 'unsatisfiable' }
  return { kind: 'part', start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) }
}
