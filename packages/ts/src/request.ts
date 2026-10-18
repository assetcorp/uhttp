import type { BodyReader } from './body/reader.js'
import { ReaderBody, type RequestBody } from './body/request-body.js'
import { UhttpError } from './errors.js'
import type { Exchange } from './exchange.js'
import { headerBytes, isDecimalDigits } from './headers.js'

const CONTENT_TYPE_NAME = headerBytes('content-type')

/**
 * The package copies these parts of the request before the first `await`, so that every
 * middleware and handler can use them after any `await`. The package copies the query string and
 * the content type only when your code first reads them, or before the first `await` when your
 * code has not read them yet.
 */
export interface RequestInfo {
  /** The client sent this method, such as `GET`, and the package leaves its case unchanged. */
  readonly method: string
  /** The path is the raw target of the request without its query string. */
  readonly path: string
  /**
   * You wrote this path when you added the route that matched the request, such as `/users/:id`.
   * It is `undefined` when no route matched, as for a 404, for a 405, or for the reply that the
   * package itself sends to an OPTIONS request.
   */
  readonly route: string | undefined
  /**
   * This is `true` when the client connected to the server over TLS. Behind a proxy that
   * terminates TLS, this is `false`, so call `protocolOf()` from `@delali/uhttp/trusted-proxies`
   * to get the protocol that the proxy reports.
   */
  readonly secure: boolean
  /**
   * The query string is the raw part of the target after the `?`, and it is empty when the target
   * has none.
   *
   * @throws {@link UhttpError} with the code `REQUEST_RELEASED` when your code reads it for the first
   * time after the package has sent a reply that your handler returned without an `await`, such as
   * from a task that the handler started without waiting for it.
   */
  readonly query: string
  /**
   * The client sent this `content-type` header, and this is `undefined` when the request has none.
   *
   * @throws {@link UhttpError} with the code `REQUEST_RELEASED` when your code reads it for the first
   * time after the package has sent a reply that your handler returned without an `await`.
   */
  readonly contentType: string | undefined
  /**
   * The client declared a body of this many bytes in `content-length`, and this is `undefined` when
   * the header is missing or is not a whole number.
   */
  readonly contentLength: number | undefined
  /**
   * The package copies the address of the client from the socket when the route or one of its
   * middleware declares `clientAddress`.
   *
   * @throws {@link UhttpError} with the code `UNDECLARED_CLIENT_ADDRESS` when nobody declared it.
   */
  readonly clientAddress: string
  /**
   * The package creates this signal the first time that your code asks for it, and the signal fires
   * when the client disconnects before the response ends, or with a `HANDLER_TIMEOUT` error as its reason
   * when the handler passes the time limit of its route.
   */
  readonly signal: AbortSignal
  /**
   * You read the request body through this object, on a POST, PUT, or PATCH route, or on a route
   * that sets `body: true`.
   *
   * @throws {@link UhttpError} with the code `REQUEST_RELEASED` when your code first reads it after
   * the package has sent a reply that your handler returned without an `await`, because the body
   * needs the content type.
   */
  readonly body: RequestBody
  /**
   * Returns the decoded value of a path parameter.
   *
   * @param name - You pass the name of the parameter in the route path, without its colon.
   * @returns The method returns the decoded value, or `undefined` when the route has no parameter
   * of that name.
   */
  param(name: string): string | undefined
  /**
   * Returns every path parameter of the route, decoded.
   *
   * @returns The method returns a new object that maps each parameter name to its value.
   */
  params(): Record<string, string>
  /**
   * Returns the value of a request header that the route or its middleware declared. The package
   * joins the lines of a list header, such as `x-forwarded-for` or `cookie`, and it returns the
   * first line of any other header.
   *
   * @param name - You can pass the header name in any case.
   * @returns The method returns the value, or `undefined` when the request has no such header or
   * an empty one.
   * @throws {@link UhttpError} with the code `UNDECLARED_HEADER` when nobody declared the header,
   * or with the code `REQUEST_RELEASED` when your code first asks for `content-type` after the
   * package has sent a reply that your handler returned without an `await`.
   */
  header(name: string): string | undefined
  /**
   * Returns every request header that the package copied for the route.
   *
   * @returns The method returns a new object whose keys are the lowercase header names.
   * @throws {@link UhttpError} with the code `REQUEST_RELEASED` when your code first calls it after
   * the package has sent a reply that your handler returned without an `await`, because the object
   * includes the content type.
   */
  headers(): Record<string, string>
}

/**
 * The package reads the query string and the content type of a request through this interface,
 * which the request of uWebSockets.js implements.
 *
 * @internal
 */
export interface LiveRequest {
  /**
   * Returns the raw query string.
   *
   * @returns The method returns the part of the target after the `?`, or an empty string or
   * `undefined` when the target has none.
   */
  getQuery(): string | undefined
  /**
   * Returns the value of a request header.
   *
   * @param lowerCaseKey - The package passes the lowercase name of the header as bytes.
   * @returns The method returns the value, or an empty string when the request has no such header.
   */
  getHeader(lowerCaseKey: ArrayBuffer): string
}

/**
 * The package passes the route that matched a request to its copy in this form, which the chain of
 * the request implements.
 *
 * @internal
 */
export interface MatchedRoute {
  /** You wrote this path when you added the route, and it is `undefined` when no route matched. */
  readonly route: string | undefined
  /** You wrote these parameter names in the route path. */
  readonly parameterNames: readonly string[]
}

/**
 * The package copies a request into this object, and it passes the object to every middleware and
 * handler as {@link RequestInfo}. The object reads the query string and the content type from the
 * live request when your code first asks for them, until the package releases the live request.
 *
 * @internal
 */
export class CopiedRequest implements RequestInfo {
  readonly method: string
  readonly path: string
  #live: LiveRequest | undefined
  #query = ''
  #queryRead = false
  #contentType: string | undefined
  #contentTypeRead = false
  readonly #contentLength: string | undefined
  readonly #exchange: Exchange
  readonly #matched: MatchedRoute
  readonly #parameterValues: readonly string[]
  readonly #headerNames: readonly string[]
  readonly #headerValues: readonly (string | undefined)[]
  readonly #allHeaders: ReadonlyMap<string, string> | undefined
  readonly #clientAddress: string | undefined
  readonly #reader: BodyReader | undefined
  #body: RequestBody | undefined

  /**
   * Creates the copy of one request.
   *
   * @param exchange - The package passes the state of the request, which creates the abort signal.
   * @param method - The client sent this method.
   * @param path - The package passes the raw path without its query string.
   * @param matched - The package passes the path and the parameter names of the route that matched.
   * @param live - The package passes the live request, from which the object reads the query string and the content type.
   * @param parameterValues - The package passes the decoded parameter values in the same order as the names.
   * @param contentLength - The client sent this raw `content-length` header, and it is `undefined` when the request has none.
   * @param headerNames - The route and its middleware declared these header names, which the package lowercased.
   * @param headerValues - The package passes the values of the declared headers in the same order as the names.
   * @param allHeaders - The package passes every header of the request when the route copies every header.
   * @param clientAddress - The package passes the client address, and it is `undefined` when nobody declared it.
   * @param reader - The package passes the body reader, and it is `undefined` on a route without one.
   */
  constructor(
    exchange: Exchange,
    method: string,
    path: string,
    matched: MatchedRoute,
    live: LiveRequest,
    parameterValues: readonly string[],
    contentLength: string | undefined,
    headerNames: readonly string[],
    headerValues: readonly (string | undefined)[],
    allHeaders: ReadonlyMap<string, string> | undefined,
    clientAddress: string | undefined,
    reader: BodyReader | undefined,
  ) {
    this.#exchange = exchange
    this.method = method
    this.path = path
    this.#matched = matched
    this.#live = live
    this.#parameterValues = parameterValues
    this.#contentLength = contentLength
    this.#headerNames = headerNames
    this.#headerValues = headerValues
    this.#allHeaders = allHeaders
    this.#clientAddress = clientAddress
    this.#reader = reader
  }

  get route(): string | undefined {
    return this.#matched.route
  }

  get query(): string {
    if (!this.#queryRead) {
      this.#query = this.#liveFor('the query string with c.req.query').getQuery() ?? ''
      this.#queryRead = true
    }
    return this.#query
  }

  get contentType(): string | undefined {
    if (!this.#contentTypeRead) {
      const value = this.#liveFor(
        'the content type with c.req.contentType, c.req.header(), c.req.headers(), or c.req.body',
      ).getHeader(CONTENT_TYPE_NAME)
      this.#contentType = value === '' ? undefined : value
      this.#contentTypeRead = true
    }
    return this.#contentType
  }

  /**
   * Stops reading from the live request, which uWebSockets.js frees once its handler returns. When
   * the response stays open, the method first copies the query string and the content type that
   * your code has not read yet, so that your code can read them after an `await`.
   *
   * @param keepUnread - The package passes `true` when the response stays open after the handler of
   * uWebSockets.js returns.
   */
  release(keepUnread: boolean): void {
    if (keepUnread) {
      void this.query
      void this.contentType
    }
    this.#live = undefined
  }

  #liveFor(part: string): LiveRequest {
    if (this.#live !== undefined) return this.#live
    throw new UhttpError(
      'REQUEST_RELEASED',
      `Read ${part} before your handler returns, because the package frees the request once it has sent a reply that the handler returned without an await.`,
    )
  }

  get body(): RequestBody {
    this.#body ??= new ReaderBody(this.#exchange, this.#reader, this.contentType)
    return this.#body
  }

  get contentLength(): number | undefined {
    const text = this.#contentLength
    if (text === undefined || !isDecimalDigits(text)) return undefined
    const length = Number(text)
    return Number.isSafeInteger(length) ? length : undefined
  }

  get clientAddress(): string {
    if (this.#clientAddress === undefined) {
      throw new UhttpError(
        'UNDECLARED_CLIENT_ADDRESS',
        'Set clientAddress to true on the route or on a middleware that wraps it before you read the client address.',
      )
    }
    return this.#clientAddress
  }

  get signal(): AbortSignal {
    return this.#exchange.signal
  }

  get secure(): boolean {
    return this.#exchange.secure
  }

  param(name: string): string | undefined {
    const index = this.#matched.parameterNames.indexOf(name)
    return index === -1 ? undefined : this.#parameterValues[index]
  }

  params(): Record<string, string> {
    const params: Record<string, string> = {}
    this.#matched.parameterNames.forEach((name, index) => {
      const value = this.#parameterValues[index]
      if (value !== undefined) params[name] = value
    })
    return params
  }

  header(name: string): string | undefined {
    const lowerName = name.toLowerCase()
    if (lowerName === 'content-type') return this.contentType
    if (lowerName === 'content-length') return this.#contentLength
    if (this.#allHeaders !== undefined) return this.#allHeaders.get(lowerName)
    const index = this.#headerNames.indexOf(lowerName)
    if (index === -1) {
      throw new UhttpError(
        'UNDECLARED_HEADER',
        `Declare the '${lowerName}' header on the route or on a middleware that wraps it before you read it.`,
      )
    }
    return this.#headerValues[index]
  }

  headers(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.contentType !== undefined) headers['content-type'] = this.contentType
    if (this.#contentLength !== undefined) headers['content-length'] = this.#contentLength
    if (this.#allHeaders !== undefined) {
      for (const [name, value] of this.#allHeaders) headers[name] = value
      return headers
    }
    this.#headerNames.forEach((name, index) => {
      const value = this.#headerValues[index]
      if (value !== undefined) headers[name] = value
    })
    return headers
  }
}
