import { BODYLESS_STATUSES, MAX_REPLY_STATUS, MIN_REPLY_STATUS } from './constants.js'
import { UhttpError } from './errors.js'

const TEXT_CONTENT_TYPE = 'text/plain; charset=UTF-8'
const JSON_CONTENT_TYPE = 'application/json'
const INTERNAL_ERROR_MESSAGE = 'The request failed.'
const NOT_FOUND_MESSAGE = 'The app has no route for this path.'
const MISSING_REPLY_MESSAGE = 'The handler must return the reply that c.text() or c.json() builds.'

/**
 * The package copies these parts of the request before your handler starts, so that your
 * handler can use them after any `await`.
 */
export interface RequestInfo {
  /** The client sent this method, such as `GET`, and the package leaves its case unchanged. */
  readonly method: string
  /** The path is the target of the request without its query string. */
  readonly path: string
  /**
   * The query string is the part of the target after the `?`, and it is an empty string when
   * the target has no `?`.
   */
  readonly query: string
}

/**
 * You get a `Reply` from {@link Context.text} or {@link Context.json}, and your handler returns
 * it so that the package can write it to the client.
 */
export class Reply {
  /** The HTTP status is a whole number from 200 to 599. */
  readonly status: number
  /** The package sends this value as the `content-type` header. */
  readonly contentType: string
  /** The package sends this text as the body, apart from a 204, a 205, or a 304, which have no body. */
  readonly body: string

  /**
   * Creates a reply. Only the package calls this constructor, because a handler builds every
   * reply through its context.
   *
   * @param status - The HTTP status must be a whole number from 200 to 599.
   * @param contentType - The package sends this value as the `content-type` header.
   * @param body - The package sends this text as the body.
   * @throws {@link UhttpError} with the code `INVALID_STATUS` when the status is a fraction,
   * below 200, or above 599.
   */
  constructor(status: number, contentType: string, body: string) {
    if (!Number.isInteger(status) || status < MIN_REPLY_STATUS || status > MAX_REPLY_STATUS) {
      throw new UhttpError(
        'INVALID_STATUS',
        `The status of a reply must be a whole number from ${MIN_REPLY_STATUS} to ${MAX_REPLY_STATUS}, and the handler passed ${status}.`,
      )
    }
    this.status = status
    this.contentType = contentType
    this.body = body
  }
}

/**
 * Your handler receives a `Context` with the request in `req` and with the methods that build a
 * reply.
 */
export class Context {
  /** The package copies these parts of the request before the handler starts. */
  readonly req: RequestInfo

  /**
   * Creates the context of one request. Only the package calls this constructor.
   *
   * @param method - The client sent this method, and the package leaves its case unchanged.
   * @param path - The path is the target of the request without its query string.
   * @param query - The query string is the part of the target after the `?`.
   */
  constructor(method: string, path: string, query: string) {
    this.req = { method, path, query }
  }

  /**
   * Returns a reply whose body is the text that you pass and whose content type is
   * `text/plain; charset=UTF-8`.
   *
   * @param body - The package sends this text as the body.
   * @param status - When you leave out the status, the package sends 200.
   * @returns Your handler returns this reply.
   * @throws {@link UhttpError} with the code `INVALID_STATUS` when the status is a fraction,
   * below 200, or above 599.
   */
  text(body: string, status = 200): Reply {
    return new Reply(status, TEXT_CONTENT_TYPE, body)
  }

  /**
   * Returns a reply whose body is the JSON text of the value that you pass and whose content type
   * is `application/json`.
   *
   * @param value - `JSON.stringify` converts this value, and the package sends `null` in place of
   * `undefined`.
   * @param status - When you leave out the status, the package sends 200.
   * @returns Your handler returns this reply.
   * @throws {@link UhttpError} with the code `INVALID_STATUS` when the status is a fraction,
   * below 200, or above 599.
   */
  json(value: unknown, status = 200): Reply {
    return new Reply(status, JSON_CONTENT_TYPE, JSON.stringify(value) ?? 'null')
  }
}

/**
 * A handler is a function that receives the {@link Context} of one request and returns a
 * {@link Reply} or a promise of one.
 *
 * @param context - The package passes the context of the request to the handler.
 * @returns The handler returns the reply, or a promise that resolves to the reply.
 */
export type Handler = (context: Context) => Reply | Promise<Reply>

function errorReply({ status, code, message }: UhttpError): Reply {
  return new Reply(status, JSON_CONTENT_TYPE, JSON.stringify({ error: { code, message } }))
}

function replyForError(error: unknown): Reply {
  if (error instanceof UhttpError && error.status < 500) return errorReply(error)
  return errorReply(new UhttpError('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE))
}

function replyForResult(result: unknown): Reply {
  if (result instanceof Reply) return result
  return replyForError(new UhttpError('INTERNAL_ERROR', MISSING_REPLY_MESSAGE))
}

/**
 * Returns a JSON 404 for a request to a path that has no route.
 *
 * @internal
 */
export const notFound: Handler = () => errorReply(new UhttpError('NOT_FOUND', NOT_FOUND_MESSAGE))

/**
 * Returns `true` when the package sends the body of a reply, which it does for every status
 * apart from 204, 205, and 304.
 *
 * @param reply - The function checks the status of this reply.
 * @returns The function returns `false` for a 204, a 205, or a 304, and `true` for every other
 * status.
 * @internal
 */
export function sendsBody(reply: Reply): boolean {
  return !BODYLESS_STATUSES.includes(reply.status)
}

/**
 * Returns the reply from a handler, and it converts an error that the handler throws, a promise
 * that rejects, or a value other than a reply into an error reply. The function returns
 * synchronously whenever the handler returns synchronously.
 *
 * @param handler - The function calls this handler.
 * @param context - The function passes this context to the handler.
 * @returns The function returns the reply, or a promise that always resolves to a reply.
 * @internal
 */
export function respond(handler: Handler, context: Context): Reply | Promise<Reply> {
  let result: unknown
  try {
    result = handler(context)
  } catch (error) {
    return replyForError(error)
  }
  if (result instanceof Reply) return result
  if (result instanceof Promise) return result.then(replyForResult, replyForError)
  return replyForResult(result)
}
