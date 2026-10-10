import { MAX_ROUTE_SEGMENTS } from '../constants.js'
import { UhttpError } from '../errors.js'

const STATIC_SEGMENT = /^(?:[A-Za-z0-9\-._~!$&'()+,;=@]|%[0-9A-Fa-f]{2})*$/
const PARAMETER_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A static segment matches exactly the same raw text, and a parameter segment matches any raw
 * segment that is not empty.
 *
 * @internal
 */
export type Segment =
  | { readonly kind: 'static'; readonly text: string }
  | { readonly kind: 'parameter'; readonly name: string }

/**
 * A prefix guard covers a route always, never, or only for some values of the route's parameters.
 *
 * @internal
 */
export type PrefixCoverage = 'always' | 'sometimes' | 'never'

/**
 * Returns the raw segments of a request path. The function splits the path on `/` before anything
 * decodes it, as the router of uWebSockets.js does.
 *
 * @param path - The path must start with `/`.
 * @returns The function returns one entry for each `/`, so it returns one empty segment for `/`,
 * and it returns `users` and an empty segment for `/users/`.
 * @internal
 */
export function splitPath(path: string): string[] {
  return path.slice(1).split('/')
}

function invalid(message: string): UhttpError {
  return new UhttpError('INVALID_ROUTE', message)
}

function parseSegments(kind: string, path: string): Segment[] {
  const rules = `Start the ${kind} '${path}' with '/', and make each of its segments a ':name' parameter or static text from the URL path alphabet, with any other character percent-encoded.`
  if (!path.startsWith('/')) throw invalid(rules)
  const raw = splitPath(path)
  if (raw.length > MAX_ROUTE_SEGMENTS) {
    throw invalid(`The ${kind} '${path}' can have at most ${MAX_ROUTE_SEGMENTS} segments.`)
  }
  const names = new Set<string>()
  return raw.map(text => {
    if (PARAMETER_SEGMENT.test(text)) {
      const name = text.slice(1)
      if (names.has(name)) {
        throw invalid(`Use each parameter name once in the ${kind} '${path}', because ':${name}' appears twice.`)
      }
      names.add(name)
      return { kind: 'parameter', name }
    }
    if (!STATIC_SEGMENT.test(text)) throw invalid(rules)
    return { kind: 'static', text }
  })
}

/**
 * Returns the segments of a route path.
 *
 * @param path - The path must start with `/`.
 * @returns The function returns one segment for each `/` in the path.
 * @throws {@link UhttpError} with the code `INVALID_ROUTE` when the path breaks the rules of the
 * router.
 * @internal
 */
export function parseRoutePath(path: string): Segment[] {
  return parseSegments('route path', path)
}

/**
 * Returns the segments of a group prefix. A prefix has no empty segment, so the function returns
 * no segments for `/`.
 *
 * @param prefix - The prefix must start with `/`, and it must end without `/` unless it is `/`.
 * @returns The function returns one segment for each `/` in the prefix.
 * @throws {@link UhttpError} with the code `INVALID_ROUTE` when the prefix breaks the rules of the
 * router or contains an empty segment.
 * @internal
 */
export function parseGroupPrefix(prefix: string): Segment[] {
  if (prefix === '/') return []
  const segments = parseSegments('group prefix', prefix)
  if (segments.some(segment => segment.kind === 'static' && segment.text === '')) {
    throw invalid(`Write the group prefix '${prefix}' with no empty segment and without a trailing '/'.`)
  }
  return segments
}

/**
 * Returns the whole path of a route that you add to a group, so that `/` inside the group `/admin`
 * becomes `/admin`.
 *
 * @param prefix - You pass the group prefix, which is `/` for the app itself.
 * @param path - You pass the route path that the group received.
 * @returns The function returns the path that the router matches.
 * @internal
 */
export function joinPath(prefix: string, path: string): string {
  if (prefix === '/') return path
  if (path === '/') return prefix
  return `${prefix}${path}`
}

/**
 * Returns `true` when the raw segments of a request start with the segments of a group prefix.
 * Each parameter segment of the prefix matches any raw segment that is not empty.
 *
 * @param prefix - You pass the segments of the group prefix.
 * @param segments - You pass the raw segments of the request path.
 * @returns The function returns `true` when every segment of the prefix matches.
 * @internal
 */
export function prefixMatches(prefix: readonly Segment[], segments: readonly string[]): boolean {
  if (segments.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index++) {
    const expected = prefix[index]
    const actual = segments[index]
    if (expected === undefined || actual === undefined) return false
    if (expected.kind === 'parameter' ? actual === '' : actual !== expected.text) return false
  }
  return true
}

/**
 * Returns whether a group prefix covers every request to a route, no request to it, or only the
 * requests whose parameter values match the static segments of the prefix.
 *
 * @param prefix - You pass the segments of the group prefix.
 * @param route - You pass the segments of the route path.
 * @returns The function returns `sometimes` when a parameter of the route stands where the prefix
 * has static text.
 * @internal
 */
export function prefixCoverage(prefix: readonly Segment[], route: readonly Segment[]): PrefixCoverage {
  if (route.length < prefix.length) return 'never'
  let coverage: PrefixCoverage = 'always'
  for (let index = 0; index < prefix.length; index++) {
    const expected = prefix[index]
    const actual = route[index]
    if (expected === undefined || actual === undefined) return 'never'
    if (expected.kind === 'parameter') {
      if (actual.kind === 'static' && actual.text === '') return 'never'
      continue
    }
    if (actual.kind === 'static') {
      if (actual.text !== expected.text) return 'never'
      continue
    }
    coverage = 'sometimes'
  }
  return coverage
}
