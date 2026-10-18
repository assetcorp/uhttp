import { randomUUID } from 'node:crypto'
import { exchangeOf } from '../../context.js'
import type { MiddlewareDefinition } from '../../types.js'
import { viaTrustedProxy } from '../client.js'
import { fixedName } from '../options.js'
import { REQUEST_ID_CHARACTERS, REQUEST_ID_HEADER, REQUEST_ID_LENGTH_LIMIT } from './constants.js'
import { setRequestId } from './ids.js'

export { requestIdOf } from './ids.js'

const VALID_REQUEST_ID = new RegExp(`^[${REQUEST_ID_CHARACTERS}]{1,${REQUEST_ID_LENGTH_LIMIT}}$`)

/**
 * Returns a middleware that assigns an ID to each request and sends the ID back in `X-Request-Id`,
 * so that you can find the request that a client reports in your logs. The middleware keeps an inbound
 * `X-Request-Id` of 1 to 255 characters from `A-Z`, `a-z`, `0-9`, `_`, `=`, and `-`, but only
 * when `trustedProxies()` trusts the peer that sent it. For every other request, it generates an
 * ID with `crypto.randomUUID()`. Read the ID with {@link requestIdOf}.
 *
 * @returns The function returns the middleware.
 */
export function requestId(): MiddlewareDefinition {
  const idName = fixedName(REQUEST_ID_HEADER)
  return {
    headers: [REQUEST_ID_HEADER],
    handle(context, next) {
      const inbound = viaTrustedProxy(context) ? context.req.header(REQUEST_ID_HEADER) : undefined
      const id = inbound !== undefined && VALID_REQUEST_ID.test(inbound) ? inbound : randomUUID()
      setRequestId(context, id)
      exchangeOf(context).setPrepared(idName, id, false)
      return next()
    },
  }
}
