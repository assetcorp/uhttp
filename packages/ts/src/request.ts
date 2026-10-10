import type { BodyReader } from './body/reader.js'
import { ReaderBody, type RequestBody } from './body/request-body.js'
import { UhttpError } from './errors.js'
import type { Exchange } from './exchange.js'
import { isDecimalDigits } from './headers.js'

/**
 * The package copies these parts of the request before the first `await`, so that every
 * middleware and handler can use them after any `await`.
 */
export interface RequestInfo {
  /** The client sent this method, such as `GET`, and the package leaves its case unchanged. */
  readonly method: string
  /** The path is the raw target of the request without its query string. */
  readonly path: string
  /** The query string is the raw part of the target after the `?`, and it is empty when the target has none. */
  readonly query: string
  /** The client sent this `content-type` header, and this is `undefined` when the request has none. */
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
   * when the client goes before the response ends, or with a `HANDLER_TIMEOUT` error as its reason
   * when the handler passes the time limit of its route.
   */
  readonly signal: AbortSignal
  /**
   * You read the request body through this object, on a POST, PUT, or PATCH route, or on a route
   * that sets `body: true`.
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
   * @throws {@link UhttpError} with the code `UNDECLARED_HEADER` when nobody declared the header.
   */
  header(name: string): string | undefined
  /**
   * Returns every request header that the package copied for the route.
   *
   * @returns The method returns a new object whose keys are the lowercase header names.
   */
  headers(): Record<string, string>
}

/**
 * The package copies a request into this object, and it passes the object to every middleware and
 * handler as {@link RequestInfo}.
 *
 * @internal
 */
export class CopiedRequest implements RequestInfo {
  readonly method: string
  readonly path: string
  readonly query: string
  readonly contentType: string | undefined
  readonly #contentLength: string | undefined
  readonly #exchange: Exchange
  readonly #parameterNames: readonly string[]
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
   * @param query - The package passes the raw query string.
   * @param parameterNames - You wrote these parameter names in the route path.
   * @param parameterValues - The package passes the decoded parameter values in the same order as the names.
   * @param contentType - The client sent this `content-type` header, and it is `undefined` when the request has none.
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
    query: string,
    parameterNames: readonly string[],
    parameterValues: readonly string[],
    contentType: string | undefined,
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
    this.query = query
    this.#parameterNames = parameterNames
    this.#parameterValues = parameterValues
    this.contentType = contentType
    this.#contentLength = contentLength
    this.#headerNames = headerNames
    this.#headerValues = headerValues
    this.#allHeaders = allHeaders
    this.#clientAddress = clientAddress
    this.#reader = reader
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

  param(name: string): string | undefined {
    const index = this.#parameterNames.indexOf(name)
    return index === -1 ? undefined : this.#parameterValues[index]
  }

  params(): Record<string, string> {
    const params: Record<string, string> = {}
    this.#parameterNames.forEach((name, index) => {
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
