/** You pass this entry to `trustedProxies()` to trust a peer that connects over a Unix socket. */
export const UNIX_SOCKET_PEER = 'unix'

/** The middleware takes the address of the client from this header. */
export const FORWARDED_FOR_HEADER = 'x-forwarded-for'

/** The middleware takes the protocol of the request from this header. */
export const FORWARDED_PROTO_HEADER = 'x-forwarded-proto'

/** The middleware takes the host of the request from this header. */
export const FORWARDED_HOST_HEADER = 'x-forwarded-host'

/** The middleware writes this message to the logger once, the first time that a peer outside the trust list sends `X-Forwarded-For`. */
export const UNTRUSTED_FORWARDING_MESSAGE =
  'A peer outside the trust list of trustedProxies() sent X-Forwarded-For, so the package used the address of the peer. Add the address of your proxy to the trust option if the peer is your proxy.'
