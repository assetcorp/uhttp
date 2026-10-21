import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import type { BodyReader } from '../body/reader.js'
import type { CopyPlan } from '../compile.js'
import { LIST_HEADER_NAMES } from '../constants.js'
import type { Exchange } from '../exchange/index.js'
import { lineSeparatorOf } from '../headers.js'
import { CopiedRequest } from '../request.js'
import type { DecodedChain } from '../resolve.js'
import { remoteAddressOf } from './close.js'
import type { RequestFraming } from './framing.js'

const NO_VALUES: readonly (string | undefined)[] = []

function copyAllHeaders(req: HttpRequest): Map<string, string> {
  const all = new Map<string, string>()
  req.forEach((name, value) => {
    if (value === '') return
    const earlier = all.get(name)
    if (earlier === undefined) all.set(name, value)
    else if (LIST_HEADER_NAMES.includes(name)) all.set(name, `${earlier}${lineSeparatorOf(name)}${value}`)
  })
  return all
}

function copyDeclaredHeaders(req: HttpRequest, plan: CopyPlan): (string | undefined)[] {
  const { headerNames, listHeaders } = plan
  const values: (string | undefined)[] = new Array(headerNames.length)
  for (let index = 0; index < headerNames.length; index++) {
    if (listHeaders[index] === true) continue
    const value = req.getHeader(headerNames[index] ?? '')
    values[index] = value === '' ? undefined : value
  }
  if (!plan.hasListHeader) return values
  req.forEach((name, value) => {
    if (value === '') return
    const index = headerNames.indexOf(name)
    if (index === -1 || listHeaders[index] !== true) return
    const earlier = values[index]
    values[index] = earlier === undefined ? value : `${earlier}${lineSeparatorOf(name)}${value}`
  })
  return values
}

/**
 * Copies the parts of a request that its chain declared, inside the synchronous handler of
 * uWebSockets.js.
 *
 * @param res - The package passes the response of uWebSockets.js, from which it reads the client address.
 * @param req - The package passes the request of uWebSockets.js.
 * @param exchange - The package passes the state of the request.
 * @param method - The client sent this method.
 * @param path - The package passes the raw path without its query string.
 * @param decoded - The package passes the chain of the request with its decoded parameter values.
 * @param framing - The package passes the framing headers that it read from the request.
 * @param reader - The package passes the body reader, or `undefined` on a route without one.
 * @returns The function returns the copy of the request.
 * @internal
 */
export function copyRequest(
  res: HttpResponse,
  req: HttpRequest,
  exchange: Exchange,
  method: string,
  path: string,
  decoded: DecodedChain,
  framing: RequestFraming,
  reader: BodyReader | undefined,
): CopiedRequest {
  const { chain, parameters } = decoded
  const plan = chain.copyPlan
  const all = plan.allHeaders ? copyAllHeaders(req) : undefined
  const values = plan.allHeaders || plan.headerNames.length === 0 ? NO_VALUES : copyDeclaredHeaders(req, plan)
  const address = plan.clientAddress ? remoteAddressOf(res) : undefined
  return new CopiedRequest(
    exchange,
    method,
    path,
    chain,
    req,
    parameters,
    framing.contentLength,
    plan.headerNames,
    values,
    all,
    address,
    reader,
  )
}
