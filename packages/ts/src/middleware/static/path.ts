import { canonicalSegment, splitPath } from '../../router/pattern.js'
import { WELL_KNOWN_FOLDER } from './constants.js'

/**
 * The middleware sorts the path of a request into one of these outcomes. A path outside the
 * prefix is `elsewhere`, a path with a hidden segment that the middleware skips is `hidden`, and
 * a path that differs from its canonical spelling is `invalid`.
 *
 * @internal
 */
export type RequestedPath =
  | { readonly kind: 'file'; readonly segments: readonly string[]; readonly folder: boolean }
  | { readonly kind: 'elsewhere' | 'hidden' | 'invalid' }

const SEPARATOR_OR_NUL = /[/\\\0]/

function decodedSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/**
 * Returns `true` when a raw segment is the one canonical spelling of its decoded form, and that
 * form can be the name of a file or a folder, which is neither `.` nor `..` and contains no `/`,
 * `\`, or NUL.
 *
 * @param raw - The middleware passes the raw segment.
 * @returns The function returns `false` for an empty segment.
 * @internal
 */
export function canonicalName(raw: string): boolean {
  const decoded = decodedSegment(raw)
  return (
    decoded !== undefined &&
    decoded !== '' &&
    decoded !== '.' &&
    decoded !== '..' &&
    !SEPARATOR_OR_NUL.test(decoded) &&
    canonicalSegment(decoded) === raw
  )
}

/**
 * Returns the decoded segments of a request path below the prefix of the middleware.
 *
 * @param path - The middleware passes the raw path of the request.
 * @param prefix - The middleware passes the raw segments of its prefix, which are empty for `/`.
 * @param serveHidden - The middleware passes `true` when it serves hidden files.
 * @returns The function returns the segments and whether the path ends with `/`, or the reason
 * that the middleware serves no file for the path.
 * @internal
 */
export function requestedPath(path: string, prefix: readonly string[], serveHidden: boolean): RequestedPath {
  const raw = splitPath(path)
  if (raw.length <= prefix.length) return { kind: 'elsewhere' }
  for (let index = 0; index < prefix.length; index++) {
    if (raw[index] !== prefix[index]) return { kind: 'elsewhere' }
  }
  const rest = raw.slice(prefix.length)
  const folder = rest.at(-1) === ''
  if (folder) rest.pop()
  const segments: string[] = []
  for (const part of rest) {
    if (!canonicalName(part)) return { kind: 'invalid' }
    const decoded = decodeURIComponent(part)
    if (!serveHidden && decoded.startsWith('.') && decoded !== WELL_KNOWN_FOLDER) return { kind: 'hidden' }
    segments.push(decoded)
  }
  return { kind: 'file', segments, folder }
}
