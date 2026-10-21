import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import type { BodyFraming } from '../body/index.js'
import { declaresNoBody } from '../body/reader.js'
import { CONNECTION_CLOSE_VALUE_LENGTH } from '../constants.js'
import type { UhttpError } from '../errors.js'
import type { Exchange } from '../exchange/index.js'
import { parserRejectsFraming, transferCodingError } from '../framing.js'
import { headerBytes } from '../headers.js'
import { refusedRequest } from './refuse.js'
import { writeFramingRejection } from './write.js'

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

const CONTENT_LENGTH = headerBytes('content-length')
const TRANSFER_ENCODING = headerBytes('transfer-encoding')
const CONNECTION = headerBytes('connection')

/**
 * Holds the framing facts that {@link readFraming} returns, as this one object, for every request
 * without `content-length` and without `transfer-encoding`.
 *
 * @internal
 */
export const NO_BODY: RequestFraming = {
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
 * `transfer-encoding`, the function makes two header lookups, with names that it built once with
 * {@link headerBytes}, and it leaves `clientCloses` false, because uWebSockets.js closes such a connection after
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
  return readBodyFraming(req, contentLength, transferEncoding)
}

function readBodyFraming(req: HttpRequest, contentLength: string, transferEncoding: string): RequestFraming {
  const lengths: string[] = []
  const encodings: string[] = []
  let contentEncoding: string | undefined
  req.forEach((name, value) => {
    if (name === 'content-length') lengths.push(value)
    else if (name === 'transfer-encoding') encodings.push(value)
    else if (name === 'content-encoding' && value !== '') {
      contentEncoding = contentEncoding === undefined ? value : `${contentEncoding}, ${value}`
    }
  })
  const parserRejects = parserRejectsFraming(lengths, encodings)
  const length = contentLength === '' ? undefined : contentLength
  const encoding = transferEncoding === '' ? undefined : transferEncoding
  return {
    contentLength: length,
    transferEncoding: encoding,
    contentEncoding,
    declaresBody: !declaresNoBody({ contentLength: length, transferEncoding: encoding }),
    clientCloses: req.getHeader(CONNECTION).length === CONNECTION_CLOSE_VALUE_LENGTH,
    parserRejects,
    rejection: parserRejects ? undefined : transferCodingError(encodings),
  }
}

/**
 * Returns the framing facts of a request that the package serves. The function returns `undefined`
 * when the package has refused the connection, when uWebSockets.js answers the request with its own
 * 400, or when the package rejects the transfer coding of the request. In each of those cases, the
 * function answers the request or leaves it alone before it returns.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param req - The package passes the request of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @returns The function returns the framing facts, or `undefined` when the package calls no
 * middleware for the request.
 * @internal
 */
export function admittedFraming(res: HttpResponse, req: HttpRequest, exchange: Exchange): RequestFraming | undefined {
  if (refusedRequest(res, exchange)) return undefined
  return admitFraming(res, req, exchange, readFraming(req))
}

/**
 * Returns the framing facts that {@link readFraming} read, when the package serves the request.
 * The function returns `undefined` when uWebSockets.js answers the request with its own 400, or
 * when the package rejects the transfer coding of the request, and it answers the request or
 * leaves it alone before it returns. The caller has already checked that the package has not
 * refused the connection.
 *
 * @param res - The package passes the response of uWebSockets.js.
 * @param req - The package passes the request of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param framing - The package passes the framing facts of the request.
 * @returns The function returns the framing facts, or `undefined` when the package calls no
 * middleware for the request.
 * @internal
 */
export function admitFraming(
  res: HttpResponse,
  req: HttpRequest,
  exchange: Exchange,
  framing: RequestFraming,
): RequestFraming | undefined {
  if (framing.parserRejects || framing.rejection !== undefined) return rejectFraming(res, req, exchange, framing)
  if (framing.clientCloses) exchange.clientCloses = true
  return framing
}

function rejectFraming(res: HttpResponse, req: HttpRequest, exchange: Exchange, framing: RequestFraming): undefined {
  if (framing.parserRejects || framing.rejection === undefined) return undefined
  writeFramingRejection(res, exchange, framing, framing.rejection, req.getCaseSensitiveMethod() === 'HEAD')
  return undefined
}
