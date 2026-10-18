/** The middleware sends this `Cache-Control` by default, so that a cache checks with the server before it reuses a file. */
export const DEFAULT_STATIC_CACHE_CONTROL = 'public, max-age=0'

/** The middleware serves this file for a request to a folder with a trailing slash by default. */
export const DEFAULT_STATIC_INDEX = 'index.html'

/** The middleware loads a file from disk in chunks of this many bytes. */
export const STATIC_READ_CHUNK_BYTES = 65536

/** The middleware serves this hidden folder even when it skips hidden files, because RFC 8615 reserves that folder for public metadata. */
export const WELL_KNOWN_FOLDER = '.well-known'

/** The middleware sends this content type for a file whose extension is not in its table. */
export const STATIC_FALLBACK_CONTENT_TYPE = 'application/octet-stream'

/** The middleware compares this request header with the entity tag of a file. */
export const IF_NONE_MATCH_HEADER = 'if-none-match'

/** The middleware compares this request header with the modification time of a file. */
export const IF_MODIFIED_SINCE_HEADER = 'if-modified-since'

/** The middleware takes the byte range that the client asks for from this request header. */
export const RANGE_HEADER = 'range'

/** The middleware sends a range only when the value of this request header equals the `Last-Modified` date. */
export const IF_RANGE_HEADER = 'if-range'

/** The middleware sends a whole file with this status. */
export const WHOLE_FILE_STATUS = 200

/** The middleware replies to a request for a byte range with this status. */
export const PARTIAL_CONTENT_STATUS = 206

/** The middleware replies with this status to a client whose copy of the file is current. */
export const NOT_MODIFIED_STATUS = 304

/** The middleware looks up the content type of each file in this table by its lowercase extension. */
export const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'text/xml; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  ics: 'text/calendar; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  jsonld: 'application/ld+json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
}
