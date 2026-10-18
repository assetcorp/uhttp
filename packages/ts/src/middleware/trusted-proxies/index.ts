import { MAX_PORT } from '../../constants.js'
import type { Context } from '../../context.js'
import type { MiddlewareDefinition } from '../../types.js'
import {
  type Address,
  type AddressRange,
  formatAddress,
  forwardedAddress,
  inRange,
  parseAddress,
  parseRange,
} from '../address.js'
import { type ForwardedClient, setForwardedClient } from '../client.js'
import { FORWARDED_HOST_LENGTH_LIMIT } from '../constants.js'
import { logToApp } from '../logger.js'
import { invalidOption, optionsObject } from '../options.js'
import {
  FORWARDED_FOR_HEADER,
  FORWARDED_HOST_HEADER,
  FORWARDED_PROTO_HEADER,
  UNIX_SOCKET_PEER,
  UNTRUSTED_FORWARDING_MESSAGE,
} from './constants.js'

export { clientAddressOf, hostOf, protocolOf } from '../client.js'

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/
const PORT = /^\d{1,5}$/

/**
 * You pass these options to {@link trustedProxies}.
 */
export interface TrustedProxiesOptions {
  /**
   * You list the proxies that you trust here, as addresses such as `10.0.0.5` or `::1`, as CIDR
   * ranges such as `10.0.0.0/8` or `fd00::/8`, and as `unix` for a peer on a Unix socket. The list
   * is empty by default, so the package treats no peer as a proxy until you add it to the list.
   */
  readonly trust?: readonly string[]
}

interface TrustList {
  readonly ranges: readonly AddressRange[]
  readonly unix: boolean
}

function checkedTrust(value: unknown): TrustList {
  if (value === undefined) return { ranges: [], unix: false }
  const hopCount = typeof value === 'number' || (Array.isArray(value) && value.some(entry => typeof entry === 'number'))
  if (hopCount || typeof value === 'boolean') {
    throw invalidOption(
      'List the addresses or CIDR ranges of your proxies in the trust option of trustedProxies(), because a client can add its own entries to X-Forwarded-For, which a hop count or true can lead the package to take as the address of the client.',
    )
  }
  if (!Array.isArray(value)) throw invalidOption('Set the trust option of trustedProxies() to a list of addresses.')
  const ranges: AddressRange[] = []
  let unix = false
  for (const entry of value) {
    if (entry === UNIX_SOCKET_PEER) {
      unix = true
      continue
    }
    const range = typeof entry === 'string' ? parseRange(entry) : undefined
    if (range === undefined) {
      throw invalidOption(
        `Write each entry of the trust option of trustedProxies() as an IP address, a CIDR range, or 'unix', and your code passed ${String(entry)}.`,
      )
    }
    ranges.push(range)
  }
  return { ranges, unix }
}

function trusts(list: TrustList, address: Address): boolean {
  for (const range of list.ranges) {
    if (inRange(address, range)) return true
  }
  return false
}

function lastEntry(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const comma = value.lastIndexOf(',')
  const entry = (comma === -1 ? value : value.slice(comma + 1)).trim()
  return entry === '' ? undefined : entry
}

function acceptedProtocol(value: string | undefined): 'http' | 'https' | undefined {
  const entry = lastEntry(value)?.toLowerCase()
  return entry === 'http' || entry === 'https' ? entry : undefined
}

function validPort(text: string): boolean {
  return PORT.test(text) && Number(text) <= MAX_PORT
}

function acceptedHost(value: string | undefined): string | undefined {
  const entry = lastEntry(value)?.toLowerCase()
  if (entry === undefined || entry.length > FORWARDED_HOST_LENGTH_LIMIT) return undefined
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close === -1 || parseAddress(entry.slice(1, close))?.family !== 6) return undefined
    const rest = entry.slice(close + 1)
    return rest === '' || (rest.startsWith(':') && validPort(rest.slice(1))) ? entry : undefined
  }
  const colon = entry.lastIndexOf(':')
  const name = colon === -1 ? entry : entry.slice(0, colon)
  if (colon !== -1 && !validPort(entry.slice(colon + 1))) return undefined
  return HOST_NAME.test(name) ? entry : undefined
}

class Forwarded implements ForwardedClient {
  readonly viaTrustedProxy: boolean
  readonly #peer: string
  readonly #peerAddress: Address | undefined
  readonly #trust: TrustList
  readonly #context: Context
  #address: string | undefined

  constructor(context: Context, trust: TrustList, peer: string, peerAddress: Address | undefined, trusted: boolean) {
    this.#context = context
    this.#trust = trust
    this.#peer = peer
    this.#peerAddress = peerAddress
    this.viaTrustedProxy = trusted
  }

  get address(): string {
    this.#address ??= this.#resolveAddress()
    return this.#address
  }

  get protocol(): 'http' | 'https' | undefined {
    return this.viaTrustedProxy ? acceptedProtocol(this.#context.req.header(FORWARDED_PROTO_HEADER)) : undefined
  }

  get host(): string | undefined {
    return this.viaTrustedProxy ? acceptedHost(this.#context.req.header(FORWARDED_HOST_HEADER)) : undefined
  }

  #resolveAddress(): string {
    const peerAddress = this.#peerAddress ?? parseAddress(this.#peer)
    let nearest = peerAddress === undefined ? this.#peer : formatAddress(peerAddress)
    const header = this.viaTrustedProxy ? this.#context.req.header(FORWARDED_FOR_HEADER) : undefined
    if (header === undefined) return nearest
    const entries = header.split(',')
    for (let index = entries.length - 1; index >= 0; index--) {
      const address = forwardedAddress((entries[index] ?? '').trim())
      if (address === undefined) return nearest
      const text = formatAddress(address)
      if (!trusts(this.#trust, address)) return text
      nearest = text
    }
    return nearest
  }
}

/**
 * Returns a middleware that takes the address, the protocol, and the host of the client from the
 * forwarding headers of the proxies that you trust. When the direct peer is a trusted proxy, the
 * package takes as the client address the rightmost address in `X-Forwarded-For`, across every
 * line of the header, that is not itself a trusted proxy. The package takes the protocol from the
 * last `X-Forwarded-Proto` entry and the host from the last `X-Forwarded-Host` entry. It
 * canonicalises every address before it compares it, so `::ffff:10.0.0.1` matches `10.0.0.1`.
 * It also drops the zone ID of an IPv6 address, and it ignores the RFC 7239 `Forwarded` header.
 * When a peer outside the list sends `X-Forwarded-For`, the package writes one warning to the
 * logger of the app.
 *
 * Add this middleware before every middleware that uses the address, the protocol, or the host of
 * the client, such as `rateLimit()`. Read those details with {@link clientAddressOf},
 * {@link protocolOf}, and {@link hostOf}.
 *
 * @param options - You list the proxies that you trust here.
 * @returns The function returns the middleware.
 * @throws {@link UhttpError} with the code `INVALID_MIDDLEWARE_OPTIONS` when `trust` is a hop count,
 * `true`, or a list with an entry that is neither an address, a CIDR range, nor `unix`.
 */
export function trustedProxies(options?: TrustedProxiesOptions): MiddlewareDefinition {
  const trust = checkedTrust(Reflect.get(optionsObject(options, 'trustedProxies()'), 'trust'))
  const trustsAddresses = trust.ranges.length > 0
  let warned = false
  return {
    headers: [FORWARDED_FOR_HEADER, FORWARDED_PROTO_HEADER, FORWARDED_HOST_HEADER],
    clientAddress: true,
    handle(context, next) {
      const peer = context.req.clientAddress
      const peerAddress = peer === '' || !trustsAddresses ? undefined : parseAddress(peer)
      const trusted = peer === '' ? trust.unix : peerAddress !== undefined && trusts(trust, peerAddress)
      const forwarded = new Forwarded(context, trust, peer, peerAddress, trusted)
      if (!trusted && !warned && context.req.header(FORWARDED_FOR_HEADER) !== undefined) {
        warned = true
        logToApp(context, 'warn', { address: forwarded.address }, UNTRUSTED_FORWARDING_MESSAGE)
      }
      setForwardedClient(context, forwarded)
      return next()
    },
  }
}
