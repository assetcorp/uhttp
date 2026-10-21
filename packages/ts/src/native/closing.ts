import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { UhttpError } from '../errors.js'
import type { Exchange } from '../exchange/index.js'
import { errorReply, type Reply } from '../reply.js'
import { followBody } from './body.js'
import { crash } from './finish.js'
import { admittedFraming } from './framing.js'
import { writeWholeReply } from './write.js'

const SERVER_CLOSING_MESSAGE = 'The server is closing, so send the request again on a new connection.'

/**
 * Sends a 503 with the code `SERVER_CLOSING` in response to a request that the client sends while
 * the server closes. The package closes the connection after that reply. The function makes the
 * same framing checks as a route handler, but it calls no middleware for such a request. It records the end of a body that the client declares, so that the package
 * can write the reply in the way that {@link writeReply} writes it while the client is still
 * sending the body.
 *
 * @param res - The package passes the response of uWebSockets.js, inside the synchronous handler.
 * @param req - The package passes the request of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @returns The function returns `true` when the response ends or the connection closes.
 * @internal
 */
export function answerWhileClosing(res: HttpResponse, req: HttpRequest, exchange: Exchange): boolean {
  let method = ''
  try {
    method = req.getCaseSensitiveMethod()
    const framing = admittedFraming(res, req, exchange)
    if (framing === undefined) return false
    if (framing.declaresBody) followBody(res, exchange, framing)
  } catch (error) {
    return crash(res, exchange, error, method, '')
  }
  return writeWholeReply(res, exchange, serverClosingReply(), method === 'HEAD')
}

/**
 * Returns the 503 with the code `SERVER_CLOSING` that a client receives while the server closes.
 *
 * @returns The function returns a new reply on every call.
 * @internal
 */
export function serverClosingReply(): Reply {
  return errorReply(new UhttpError('SERVER_CLOSING', SERVER_CLOSING_MESSAGE))
}
