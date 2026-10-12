import type { HttpRequest } from 'uWebSockets.js'
import type { BodyFraming } from '../body/index.js'
import { declaresNoBody } from '../body/reader.js'
import { CONNECTION_CLOSE_VALUE_LENGTH } from '../constants.js'
import type { UhttpError } from '../errors.js'
import { parserRejectsFraming, transferCodingError } from '../framing.js'

/**
 * The package reads these framing facts of a request from uWebSockets.js inside the synchronous
 * handler.
 *
 * @internal
 */
export interface RequestFraming extends BodyFraming {
  /** This is `true` when body bytes follow the head of the request. */
  readonly declaresBody: boolean
  /** This is `true` when uWebSockets.js closes the connection after the response, because the client sent `Connection: close`. */
  readonly clientCloses: boolean
  /** This is `true` when uWebSockets.js answers the request with its own 400 once the handler returns. */
  readonly parserRejects: boolean
  /** The package answers the request with this error before it calls any handler, and it is `undefined` otherwise. */
  readonly rejection: UhttpError | undefined
}

const CONTENT_LENGTH = Buffer.from('content-length')
const TRANSFER_ENCODING = Buffer.from('transfer-encoding')
const CONNECTION = Buffer.from('connection')

const NO_BODY: RequestFraming = {
  contentLength: undefined,
  transferEncoding: undefined,
  contentEncoding: undefined,
  declaresBody: false,
  clientCloses: false,
  parserRejects: false,
  rejection: undefined,
}

/**
 * Returns the framing facts of a request. For a request without `content-length` and
 * `transfer-encoding`, the function makes two header lookups, with names that it built once as
 * bytes, and it leaves `clientCloses` false, because uWebSockets.js closes such a connection after
 * the response without help. For a request with either header, it also walks every header, so that
 * it finds repeated lines and joins every `content-encoding` line into one value.
 *
 * @param req - The package passes the request of uWebSockets.js, which is valid until the handler returns.
 * @returns The function returns the framing facts.
 * @internal
 */
export function readFraming(req: HttpRequest): RequestFraming {
  const contentLength = req.getHeader(CONTENT_LENGTH)
  const transferEncoding = req.getHeader(TRANSFER_ENCODING)
  if (contentLength === '' && transferEncoding === '') return NO_BODY
  const lengths: string[] = []
  const encodings: string[] = []
  const codings: string[] = []
  req.forEach((name, value) => {
    if (name === 'content-length') lengths.push(value)
    else if (name === 'transfer-encoding') encodings.push(value)
    else if (name === 'content-encoding' && value !== '') codings.push(value)
  })
  const parserRejects = parserRejectsFraming(lengths, encodings)
  const lines = {
    contentLength: contentLength === '' ? undefined : contentLength,
    transferEncoding: transferEncoding === '' ? undefined : transferEncoding,
    contentEncoding: codings.length === 0 ? undefined : codings.join(', '),
  }
  return {
    ...lines,
    declaresBody: !declaresNoBody(lines),
    clientCloses: req.getHeader(CONNECTION).length === CONNECTION_CLOSE_VALUE_LENGTH,
    parserRejects,
    rejection: parserRejects ? undefined : transferCodingError(encodings),
  }
}
