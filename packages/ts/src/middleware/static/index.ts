import { realpathSync, type Stats, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { type Context, exchangeOf } from '../../context.js'
import { UhttpError } from '../../errors.js'
import { createReply, type Reply } from '../../reply.js'
import type { PreparedName } from '../../response.js'
import { canonicalSegment, splitPath } from '../../router/pattern.js'
import type { MiddlewareDefinition } from '../../types.js'
import { fixedHeader, fixedName, invalidOption, optionsObject } from '../options.js'
import { byteRange, entityTag, matchesNoneMatch, unmodifiedSince } from './conditional.js'
import {
  DEFAULT_STATIC_CACHE_CONTROL,
  DEFAULT_STATIC_INDEX,
  IF_MODIFIED_SINCE_HEADER,
  IF_NONE_MATCH_HEADER,
  IF_RANGE_HEADER,
  NOT_MODIFIED_STATUS,
  PARTIAL_CONTENT_STATUS,
  RANGE_HEADER,
  STATIC_CONTENT_TYPES,
  STATIC_FALLBACK_CONTENT_TYPE,
  WHOLE_FILE_STATUS,
} from './constants.js'
import { locate, regularFile } from './locate.js'
import { canonicalName, requestedPath } from './path.js'
import { fileProducer } from './send.js'

/**
 * You pass these options to {@link serveStatic}.
 */
export interface ServeStaticOptions {
  /** The middleware serves the files inside this folder, which you create before you call {@link serveStatic}. */
  readonly root: string
  /**
   * The middleware serves a request whose path starts with this prefix, such as `/assets`, from
   * the folder, so that it serves `app.js` for `/assets/app.js`. The prefix is `/` by default.
   */
  readonly prefix?: string
  /**
   * The middleware skips a path with a segment that starts with a dot, apart from `.well-known`,
   * by default, which is `ignore`. Pass `allow` to serve such files.
   */
  readonly dotfiles?: 'ignore' | 'allow'
  /** The middleware sends this `Cache-Control` with every file, which is `public, max-age=0` by default. */
  readonly cacheControl?: string
  /**
   * The middleware serves this file for a request to a folder that ends with `/`, which is
   * `index.html` by default. Pass `false` to serve no index file.
   */
  readonly index?: string | false
}

interface StaticPlan {
  readonly root: string
  readonly prefix: readonly string[]
  readonly serveHidden: boolean
  readonly cacheControl: string
  readonly index: string | undefined
  readonly contentRangeName: PreparedName
}

function checkedRoot(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw invalidOption('Set the root option of serveStatic() to a folder.')
  }
  try {
    const real = realpathSync.native(resolve(value))
    if (statSync(real).isDirectory()) return real
  } catch {
    throw invalidOption(`Set the root option of serveStatic() to a folder that exists, and '${value}' is not one.`)
  }
  throw invalidOption(`Set the root option of serveStatic() to a folder, and '${value}' is a file.`)
}

function checkedPrefix(value: unknown): readonly string[] {
  if (value === undefined || value === '/') return []
  const segments = typeof value === 'string' && value.startsWith('/') ? splitPath(value) : undefined
  if (segments === undefined || !segments.every(canonicalName)) {
    throw invalidOption(
      "Set the prefix option of serveStatic() to a path such as '/assets', which starts with '/', ends without one, and spells each segment in its canonical form.",
    )
  }
  return segments
}

function checkedIndex(value: unknown): string | undefined {
  if (value === false) return undefined
  if (value === undefined) return DEFAULT_STATIC_INDEX
  const raw = typeof value === 'string' ? canonicalSegment(value) : undefined
  if (typeof value !== 'string' || raw === undefined || !canonicalName(raw)) {
    throw invalidOption('Set the index option of serveStatic() to a file name without a slash, or to false.')
  }
  return value
}

function staticPlan(options: object): StaticPlan {
  const dotfiles: unknown = Reflect.get(options, 'dotfiles')
  if (dotfiles !== undefined && dotfiles !== 'ignore' && dotfiles !== 'allow') {
    throw invalidOption("Set the dotfiles option of serveStatic() to 'ignore' or 'allow'.")
  }
  const cacheControl: unknown = Reflect.get(options, 'cacheControl') ?? DEFAULT_STATIC_CACHE_CONTROL
  if (typeof cacheControl !== 'string') throw invalidOption('Set the cacheControl option of serveStatic() to a string.')
  return {
    root: checkedRoot(Reflect.get(options, 'root')),
    prefix: checkedPrefix(Reflect.get(options, 'prefix')),
    serveHidden: dotfiles === 'allow',
    cacheControl: fixedHeader('cache-control', cacheControl).value,
    index: checkedIndex(Reflect.get(options, 'index')),
    contentRangeName: fixedName('content-range'),
  }
}

function contentTypeOf(path: string): string {
  return STATIC_CONTENT_TYPES[extname(path).slice(1).toLowerCase()] ?? STATIC_FALLBACK_CONTENT_TYPE
}

function fileReply(context: Context, path: string, stats: Stats, plan: StaticPlan): Reply {
  const tag = entityTag(stats.size, stats.mtimeMs)
  const modified = new Date(stats.mtimeMs).toUTCString()
  const headers = new Map<string, string[]>([
    ['etag', [tag]],
    ['last-modified', [modified]],
    ['cache-control', [plan.cacheControl]],
  ])
  const noneMatch = context.req.header(IF_NONE_MATCH_HEADER)
  const modifiedSince = context.req.header(IF_MODIFIED_SINCE_HEADER)
  const current =
    noneMatch !== undefined
      ? matchesNoneMatch(noneMatch, tag)
      : modifiedSince !== undefined && unmodifiedSince(modifiedSince, stats.mtimeMs)
  if (current) return createReply(NOT_MODIFIED_STATUS, undefined, null, headers)
  headers.set('accept-ranges', ['bytes'])
  const ifRange = context.req.header(IF_RANGE_HEADER)
  const range =
    context.req.method === 'GET' && (ifRange === undefined || ifRange === modified)
      ? byteRange(context.req.header(RANGE_HEADER), stats.size)
      : ({ kind: 'whole' } as const)
  if (range.kind === 'unsatisfiable') {
    exchangeOf(context).response.setPrepared(plan.contentRangeName, `bytes */${stats.size}`, false)
    throw new UhttpError(
      'RANGE_NOT_SATISFIABLE',
      `The file has ${stats.size} bytes, so the range starts at or past its end.`,
    )
  }
  const start = range.kind === 'part' ? range.start : 0
  const length = range.kind === 'part' ? range.end - range.start + 1 : stats.size
  if (range.kind === 'part') headers.set('content-range', [`bytes ${range.start}-${range.end}/${stats.size}`])
  const status = range.kind === 'part' ? PARTIAL_CONTENT_STATUS : WHOLE_FILE_STATUS
  return createReply(status, contentTypeOf(path), null, headers, {
    produce: fileProducer(path, stats, start, length),
    length,
  })
}

/**
 * Returns a middleware that serves the files inside a folder for GET and HEAD requests. It passes
 * every other request, and every request for a file that is missing from the folder, on to the
 * routes.
 *
 * The middleware checks the path the way that the router does. After it decodes each segment once,
 * the package replies with a 404 when the raw path differs from its canonical spelling, as with
 * `%2E%2E`, `//`, or lowercase hex. The middleware serves only files inside the folder, and on a
 * case-insensitive filesystem, it compares the spelling on disk with the spelling in the path. It
 * follows a symlink only when the target is inside the folder, while it skips a path with a hidden
 * segment, apart from `.well-known`.
 *
 * The middleware sends each file with a content type from the extension, a weak `ETag` from the
 * size and the modification time, `Last-Modified`, and by default
 * `Cache-Control: public, max-age=0`. It replies with a 304 when the `If-None-Match` header matches
 * the tag of the file, or, when the client sends no `If-None-Match`, when the date of
 * `If-Modified-Since` is at or after the modification time. It replies to one byte range with a
 * 206, while the package replies with a 416 to a range that starts at or past the end of the file.
 * The middleware sends the whole file for several ranges or for an `If-Range` other than the exact
 * `Last-Modified` date. It streams each file at the pace of a slow client.
 *
 * @param options - You pass the folder, and you can set the prefix, the hidden-file rule, the
 * `Cache-Control`, and the index file.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when `root` is not a folder,
 * when `prefix` is not a canonical path, when `dotfiles` is not `ignore` or `allow`, when
 * `cacheControl` contains a control character, or when `index` contains a slash.
 */
export function serveStatic(options: ServeStaticOptions): MiddlewareDefinition {
  const plan = staticPlan(optionsObject(options, 'serveStatic()'))
  return {
    headers: [IF_NONE_MATCH_HEADER, IF_MODIFIED_SINCE_HEADER, RANGE_HEADER, IF_RANGE_HEADER],
    async handle(context, next) {
      const reply = await staticReply(context, plan)
      if (reply !== undefined) return reply
      await next()
      return undefined
    },
  }
}

async function staticReply(context: Context, plan: StaticPlan): Promise<Reply | undefined> {
  const { method, path } = context.req
  if (method !== 'GET' && method !== 'HEAD') return undefined
  const requested = requestedPath(path, plan.prefix, plan.serveHidden)
  if (requested.kind === 'invalid') throw new UhttpError('NOT_FOUND', 'The path has no canonical file name.')
  if (requested.kind !== 'file') return undefined
  const { index } = plan
  if (requested.folder && index === undefined) return undefined
  const segments = requested.folder && index !== undefined ? [...requested.segments, index] : requested.segments
  const real = await locate(plan.root, segments)
  const stats = real === undefined ? undefined : await regularFile(real)
  if (real === undefined || stats === undefined) return undefined
  return fileReply(context, real, stats, plan)
}
