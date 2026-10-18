import { IPV4_BYTES, IPV6_BYTES, IPV6_GROUPS, MAPPED_IPV4_ZERO_BYTES, MAX_IPV6_TEXT_LENGTH } from './constants.js'

const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/
const IPV6_GROUP = /^[0-9A-Fa-f]{1,4}$/
const PREFIX_LENGTH = /^(?:0|[1-9]\d{0,2})$/
const PORT_SUFFIX = /^:\d{1,5}$/
const BITS_PER_BYTE = 8
const MAX_OCTET = 255
const MAPPED_MARKER = 0xff
const HEX = 16

/**
 * The package parses an IP address into this form, in which the package stores an IPv4-mapped
 * IPv6 address as the IPv4 address that it maps.
 *
 * @internal
 */
export interface Address {
  /** This is 4 for an IPv4 address and 6 for an IPv6 address. */
  readonly family: 4 | 6
  /** The address has 4 bytes for IPv4 and 16 bytes for IPv6. */
  readonly bytes: Uint8Array
}

/**
 * The package parses an address or a CIDR range into this form.
 *
 * @internal
 */
export interface AddressRange extends Address {
  /** Every address in the range shares this many leading bits with the bytes. */
  readonly prefix: number
}

function parseIPv4(text: string, into: Uint8Array, at: number): boolean {
  const parts = text.split('.')
  if (parts.length !== IPV4_BYTES) return false
  for (let index = 0; index < IPV4_BYTES; index++) {
    const part = parts[index] ?? ''
    if (!IPV4_OCTET.test(part)) return false
    const value = Number(part)
    if (value > MAX_OCTET) return false
    into[at + index] = value
  }
  return true
}

function groupsOf(text: string): string[] {
  return text === '' ? [] : text.split(':')
}

function writeGroups(groups: readonly string[], into: Uint8Array, start: number, allowIPv4: boolean): number {
  let at = start
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index] ?? ''
    if (allowIPv4 && index === groups.length - 1 && group.includes('.')) {
      if (at + IPV4_BYTES > IPV6_BYTES || !parseIPv4(group, into, at)) return -1
      return at + IPV4_BYTES
    }
    if (!IPV6_GROUP.test(group) || at + 2 > IPV6_BYTES) return -1
    const value = Number.parseInt(group, HEX)
    into[at] = value >> BITS_PER_BYTE
    into[at + 1] = value & MAX_OCTET
    at += 2
  }
  return at
}

function parseIPv6(text: string): Uint8Array | undefined {
  if (text.length > MAX_IPV6_TEXT_LENGTH) return undefined
  const bytes = new Uint8Array(IPV6_BYTES)
  const gap = text.indexOf('::')
  if (gap === -1) {
    return writeGroups(groupsOf(text), bytes, 0, true) === IPV6_BYTES ? bytes : undefined
  }
  if (text.includes('::', gap + 1)) return undefined
  const head = groupsOf(text.slice(0, gap))
  const tail = groupsOf(text.slice(gap + 2))
  if (head.includes('') || tail.includes('')) return undefined
  const headEnd = writeGroups(head, bytes, 0, false)
  if (headEnd === -1) return undefined
  const tailBytes = new Uint8Array(IPV6_BYTES)
  const tailEnd = writeGroups(tail, tailBytes, 0, true)
  if (tailEnd === -1 || headEnd + tailEnd > IPV6_BYTES - 2) return undefined
  bytes.set(tailBytes.subarray(0, tailEnd), IPV6_BYTES - tailEnd)
  return bytes
}

function isMappedIPv4(bytes: Uint8Array): boolean {
  for (let index = 0; index < MAPPED_IPV4_ZERO_BYTES; index++) {
    if (bytes[index] !== 0) return false
  }
  return bytes[MAPPED_IPV4_ZERO_BYTES] === MAPPED_MARKER && bytes[MAPPED_IPV4_ZERO_BYTES + 1] === MAPPED_MARKER
}

/**
 * Returns the parsed form of an IPv4 or IPv6 address. The function drops the zone ID of an IPv6
 * address, such as `%eth0`, and it turns an IPv4-mapped IPv6 address, such as `::ffff:10.0.0.1`,
 * into the IPv4 address that it maps.
 *
 * @param text - The function parses this text, which has no brackets and no port.
 * @returns The function returns the address, or `undefined` for text that is not an IP address.
 * @internal
 */
export function parseAddress(text: string): Address | undefined {
  if (!text.includes(':')) {
    const bytes = new Uint8Array(IPV4_BYTES)
    return parseIPv4(text, bytes, 0) ? { family: 4, bytes } : undefined
  }
  const zone = text.indexOf('%')
  const bytes = parseIPv6(zone === -1 ? text : text.slice(0, zone))
  if (bytes === undefined) return undefined
  if (isMappedIPv4(bytes)) return { family: 4, bytes: bytes.slice(IPV6_BYTES - IPV4_BYTES) }
  return { family: 6, bytes }
}

function longestZeroRun(groups: readonly number[]): { start: number; length: number } {
  let best = { start: -1, length: 0 }
  let start = -1
  for (let index = 0; index <= groups.length; index++) {
    if (index < groups.length && groups[index] === 0) {
      if (start === -1) start = index
      continue
    }
    if (start !== -1 && index - start > best.length) best = { start, length: index - start }
    start = -1
  }
  return best
}

/**
 * Returns the text of an address in its canonical form: dotted decimal for IPv4, and for IPv6 the
 * lowercase form of RFC 5952, without leading zeros and with `::` in place of the longest run of
 * two or more zero groups.
 *
 * @param address - The middleware passes the address.
 * @returns The function returns the text, such as `10.0.0.1` or `2001:db8::1`.
 * @internal
 */
export function formatAddress(address: Address): string {
  const { bytes } = address
  if (address.family === 4) return Array.from(bytes).join('.')
  const groups: number[] = []
  for (let index = 0; index < IPV6_GROUPS; index++) {
    groups.push(((bytes[index * 2] ?? 0) << BITS_PER_BYTE) | (bytes[index * 2 + 1] ?? 0))
  }
  const run = longestZeroRun(groups)
  const text = groups.map(group => group.toString(HEX))
  if (run.length < 2) return text.join(':')
  const head = text.slice(0, run.start).join(':')
  const tail = text.slice(run.start + run.length).join(':')
  return `${head}::${tail}`
}

/**
 * Returns the canonical text of an address, as {@link formatAddress} writes it, or the text
 * unchanged when it is not an IP address, such as the empty address of a client on a Unix socket.
 *
 * @param text - The middleware passes the address.
 * @returns The function returns the canonical text.
 * @internal
 */
export function canonicalAddress(text: string): string {
  const address = parseAddress(text)
  return address === undefined ? text : formatAddress(address)
}

/**
 * Returns the parsed form of an address or of a CIDR range such as `10.0.0.0/8` or `fd00::/8`. For
 * a plain address, the range contains that address alone.
 *
 * @param text - The function parses this text.
 * @returns The function returns the range, or `undefined` for text that is neither an address nor a
 * range whose prefix length fits the number of bits in its family.
 * @internal
 */
export function parseRange(text: string): AddressRange | undefined {
  const slash = text.indexOf('/')
  const address = parseAddress(slash === -1 ? text : text.slice(0, slash))
  if (address === undefined) return undefined
  const bits = address.bytes.length * BITS_PER_BYTE
  if (slash === -1) return { ...address, prefix: bits }
  const prefixText = text.slice(slash + 1)
  if (!PREFIX_LENGTH.test(prefixText)) return undefined
  let prefix = Number(prefixText)
  const mapped = address.family === 4 && text.slice(0, slash).includes(':')
  if (mapped) prefix -= (IPV6_BYTES - IPV4_BYTES) * BITS_PER_BYTE
  if (prefix < 0 || prefix > bits) return undefined
  return { ...address, prefix }
}

/**
 * Returns `true` when an address is inside a range of the same family.
 *
 * @param address - The function checks this address.
 * @param range - The function checks the address against this range.
 * @returns The function returns `false` for an address of the other family.
 * @internal
 */
export function inRange(address: Address, range: AddressRange): boolean {
  if (address.family !== range.family) return false
  const whole = Math.floor(range.prefix / BITS_PER_BYTE)
  for (let index = 0; index < whole; index++) {
    if (address.bytes[index] !== range.bytes[index]) return false
  }
  const rest = range.prefix % BITS_PER_BYTE
  if (rest === 0) return true
  const mask = (MAX_OCTET << (BITS_PER_BYTE - rest)) & MAX_OCTET
  return ((address.bytes[whole] ?? 0) & mask) === ((range.bytes[whole] ?? 0) & mask)
}

/**
 * Returns the address that a client wrote in one entry of a forwarding header. The function also
 * parses an IPv6 address in brackets, and it drops a port after an IPv4 address or after the
 * brackets.
 *
 * @param entry - The middleware passes the entry, which has no surrounding space.
 * @returns The function returns the address, or `undefined` for an entry without an address.
 * @internal
 */
export function forwardedAddress(entry: string): Address | undefined {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close === -1) return undefined
    const after = entry.slice(close + 1)
    if (after !== '' && !PORT_SUFFIX.test(after)) return undefined
    return parseAddress(entry.slice(1, close))
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && colon === entry.lastIndexOf(':') && PORT_SUFFIX.test(entry.slice(colon))) {
    return parseAddress(entry.slice(0, colon))
  }
  return parseAddress(entry)
}
