import type { Context } from '../context.js'
import { canonicalAddress } from './address.js'

/**
 * The trusted-proxy middleware stores the details of the client of a request in this form.
 *
 * @internal
 */
export interface ForwardedClient {
  /** This is `true` when the direct peer of the request is a proxy that you trust. */
  readonly viaTrustedProxy: boolean
  /** This is the canonical address of the client, from the forwarding header of a trusted proxy or from the socket. */
  readonly address: string
  /** This is the protocol that a trusted proxy reported, or `undefined` when it reported no valid protocol. */
  readonly protocol: 'http' | 'https' | undefined
  /** This is the host that a trusted proxy reported, or `undefined` when it reported no valid host. */
  readonly host: string | undefined
}

const clients = new WeakMap<Context, ForwardedClient>()

/**
 * Stores the details of the client of a request that the trusted-proxy middleware found.
 *
 * @param context - The middleware passes the context of the request.
 * @param client - The middleware passes the details of the client.
 * @internal
 */
export function setForwardedClient(context: Context, client: ForwardedClient): void {
  clients.set(context, client)
}

/**
 * Returns the address of the client in canonical form, as `10.0.0.1` or `2001:db8::1`. When
 * `trustedProxies()` trusts the peer, the function takes the address from `X-Forwarded-For`, and
 * otherwise it returns the address of the peer. For a client on a Unix socket, the function returns
 * the empty string.
 *
 * @param context - You pass the context of the request, on a route or a middleware that declares
 * `clientAddress`, such as `trustedProxies()`.
 * @returns The function returns the address of the client.
 * @throws {@link UhttpError} with the code `UNDECLARED_CLIENT_ADDRESS` when neither the route nor
 * any of its middleware declared the client address.
 */
export function clientAddressOf(context: Context): string {
  return clients.get(context)?.address ?? canonicalAddress(context.req.clientAddress)
}

/**
 * Returns the protocol of the request. When `trustedProxies()` trusts the peer, the function takes
 * the protocol from the last entry of `X-Forwarded-Proto`, as long as that entry is `http` or
 * `https`. Otherwise, the function returns `https` on a TLS connection and `http` on any other.
 *
 * @param context - You pass the context of the request.
 * @returns The function returns `http` or `https`.
 */
export function protocolOf(context: Context): 'http' | 'https' {
  return clients.get(context)?.protocol ?? (context.req.secure ? 'https' : 'http')
}

/**
 * Returns the host that the client asked for. When `trustedProxies()` trusts the peer, the function
 * takes the host from the last entry of `X-Forwarded-Host`, as long as that entry is a valid host.
 * Otherwise, the function takes the host from the `Host` header of the request.
 *
 * @param context - You pass the context of the request, on a route or a middleware that declares
 * the `host` header, unless a trusted proxy reported the host.
 * @returns The function returns the host in lowercase, which can end with a port, or `undefined`
 * when the request has none.
 * @throws {@link UhttpError} with the code `UNDECLARED_HEADER` when the function has to take the
 * host from the `Host` header and neither the route nor any of its middleware declared it.
 */
export function hostOf(context: Context): string | undefined {
  return clients.get(context)?.host ?? context.req.header('host')?.toLowerCase()
}

/**
 * Returns `true` when you put `trustedProxies()` in front of the route and the peer that sent the
 * request is one of the proxies that you trust.
 *
 * @param context - The middleware passes the context of the request.
 * @returns The function returns `false` when no trusted proxy sent the request.
 * @internal
 */
export function viaTrustedProxy(context: Context): boolean {
  return clients.get(context)?.viaTrustedProxy === true
}
