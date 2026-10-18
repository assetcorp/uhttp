/** An IPv4 address has this many bytes. */
export const IPV4_BYTES = 4

/** An IPv6 address has this many bytes. */
export const IPV6_BYTES = 16

/** An IPv6 address has this many 16-bit groups. */
export const IPV6_GROUPS = 8

/** The text of an IPv6 address can have at most this many characters, as in `ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255`. */
export const MAX_IPV6_TEXT_LENGTH = 45

/** An IPv4-mapped IPv6 address starts with this many zero bytes, which two bytes of `0xff` follow. */
export const MAPPED_IPV4_ZERO_BYTES = 10

/** The trusted-proxy middleware ignores a host in `X-Forwarded-Host` of more than this many characters, which allows 253 for a DNS name and 6 for a colon and a port. */
export const FORWARDED_HOST_LENGTH_LIMIT = 259
