import { type CompiledApp, type CopyPlan, copyPlanOf, handlerOf } from './compile.js'
import { OPTIONS_STATUS } from './constants.js'
import { UhttpError } from './errors.js'
import { createReply, errorReply } from './reply.js'
import { prefixMatches, splitPath } from './router/index.js'
import type { Handler, MiddlewareHandler } from './types.js'

const NOT_FOUND_MESSAGE = 'The app has no route for this path.'
const INVALID_PARAMETER_MESSAGE = 'A path parameter contains a percent sequence that fails to decode.'
const NO_PARAMETERS: readonly string[] = []

/**
 * The package sends a request through this chain after it copies the parts of the request that
 * the chain declared.
 *
 * @internal
 */
export interface RequestChain {
  /** The package calls this middleware in order: app, group, then route. */
  readonly layers: readonly MiddlewareHandler[]
  /** The package calls this handler at the end of the chain. */
  readonly handler: Handler
  /** The package copies the request for the chain by this plan. */
  readonly copyPlan: CopyPlan
  /** You wrote these parameter names in the route path, in this order. */
  readonly parameterNames: readonly string[]
  /** The request path has these raw parameter values, in the same order as the names. */
  readonly rawParameters: readonly string[]
  /** This is `true` when the chain ends in the handler of a route. */
  readonly matchedRoute: boolean
}

/**
 * The package sends a request through this chain with these decoded parameter values.
 *
 * @internal
 */
export interface DecodedChain {
  /** The package sends the request through this chain. */
  readonly chain: RequestChain
  /** The package decoded these parameter values, in the same order as the parameter names. */
  readonly parameters: readonly string[]
}

const defaultNotFound: Handler = () => errorReply(new UhttpError('NOT_FOUND', NOT_FOUND_MESSAGE))

function answerOptions(allow: string): Handler {
  return context => {
    context.header('allow', allow)
    return createReply(OPTIONS_STATUS, undefined, null)
  }
}

function refuseMethod(allow: string): Handler {
  return context => {
    context.header('allow', allow)
    throw new UhttpError('METHOD_NOT_ALLOWED', `This path has routes for ${allow} alone.`)
  }
}

function fallbackChain(app: CompiledApp, method: string, segments: readonly string[]): RequestChain {
  const guards = app.guards.filter(guard => prefixMatches(guard.segments, segments))
  const allowed = app.methods.filter(candidate => app.matcher.match(candidate, segments) !== undefined)
  if (allowed.length > 0 && !allowed.includes('OPTIONS')) allowed.push('OPTIONS')
  const allow = allowed.join(', ')
  let handler: Handler
  if (allowed.length === 0) handler = app.runtime.notFound ?? defaultNotFound
  else if (method === 'OPTIONS') handler = answerOptions(allow)
  else handler = refuseMethod(allow)
  const wrapping = { layers: app.appLayers, copyPlan: app.appCopyPlan }
  if (guards.length > 0) {
    const middleware = [...app.appMiddleware, ...guards.flatMap(guard => guard.middleware)]
    wrapping.layers = middleware.map(handlerOf)
    wrapping.copyPlan = copyPlanOf(middleware)
  }
  return { ...wrapping, handler, parameterNames: NO_PARAMETERS, rawParameters: NO_PARAMETERS, matchedRoute: false }
}

/**
 * Returns the chain of a request through the JavaScript matcher. When a route of the method
 * matches, the chain ends in that route. Otherwise, the chain ends in a 404 for a path with no
 * route, in the `Allow` list for OPTIONS, or in a 405 for another method, and the middleware of
 * the app and of every group whose prefix matches the raw path wraps it.
 *
 * @param app - The package passes the compiled app.
 * @param method - The client sent this method, which the matcher compares with its case.
 * @param path - The package passes the raw path without its query string.
 * @returns The function returns the chain of the request.
 * @internal
 */
export function resolveChain(app: CompiledApp, method: string, path: string): RequestChain {
  const segments = splitPath(path)
  const match = app.matcher.match(method, segments)
  if (match === undefined) return fallbackChain(app, method, segments)
  const route = match.value
  return {
    layers: route.layers,
    handler: route.handler,
    copyPlan: route.copyPlan,
    parameterNames: route.parameterNames,
    rawParameters: match.parameters,
    matchedRoute: true,
  }
}

function invalidParameterChain(app: CompiledApp): RequestChain {
  return {
    layers: app.appLayers,
    handler: () => {
      throw new UhttpError('INVALID_PATH_PARAMETER', INVALID_PARAMETER_MESSAGE)
    },
    copyPlan: app.appCopyPlan,
    parameterNames: NO_PARAMETERS,
    rawParameters: NO_PARAMETERS,
    matchedRoute: false,
  }
}

function decodeParameter(value: string): string | undefined {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * Decodes each raw parameter value of a chain once. When a value contains a percent sequence that
 * fails to decode, the function returns a chain in its place, in which the middleware of the app
 * wraps a 400 with the code `INVALID_PATH_PARAMETER`.
 *
 * @param app - The package passes the compiled app.
 * @param chain - The package passes the chain of the request with its raw parameter values.
 * @returns The function returns the chain to send the request through, with the decoded values.
 * @internal
 */
export function decodeChain(app: CompiledApp, chain: RequestChain): DecodedChain {
  if (chain.rawParameters.length === 0) return { chain, parameters: NO_PARAMETERS }
  const parameters: string[] = []
  for (const value of chain.rawParameters) {
    const decoded = decodeParameter(value)
    if (decoded === undefined) return { chain: invalidParameterChain(app), parameters: NO_PARAMETERS }
    parameters.push(decoded)
  }
  return { chain, parameters }
}
