import { MAX_HOSTNAME_LABELS, MAX_HOSTNAME_LENGTH } from '../constants.js'
import { UhttpError } from '../errors.js'

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const WILDCARD_LABEL = '*'

/**
 * You pass the key and the certificate of one hostname to {@link serve} in this shape.
 */
export interface TlsCertificate {
  /** The package loads the private key in PEM form from this file. */
  keyFile: string
  /** The package loads the certificate in PEM form from this file, which can contain the intermediate certificates after your certificate. */
  certFile: string
  /** The package decrypts the key with this passphrase, which you pass for an encrypted key alone. */
  passphrase?: string
}

/**
 * You pass these options as `tls` to {@link serve} to serve HTTPS. The server sends the
 * certificate at the top level to every client that sends a hostname outside `hostnames`.
 */
export interface TlsOptions extends TlsCertificate {
  /**
   * The server sends the certificate under each hostname, such as `api.example.com` or
   * `*.example.com`, to a client that sends that hostname. The server serves the same routes under
   * every hostname. A `*` stands for the first label of a hostname alone. The package stores each
   * hostname in lowercase.
   */
  hostnames?: Record<string, TlsCertificate>
}

/**
 * The package stores a key and a certificate in this form once it checks them.
 *
 * @internal
 */
export interface CheckedCertificate {
  /** The package loads the private key from this file. */
  readonly keyFile: string
  /** The package loads the certificate from this file. */
  readonly certFile: string
  /** The package decrypts the key with this passphrase, which is `undefined` for a key without one. */
  readonly passphrase: string | undefined
}

/**
 * The package stores the `tls` option of {@link serve} in this form once it checks the option.
 *
 * @internal
 */
export interface CheckedTls {
  /** The server sends this certificate to a client that sends a hostname outside the list. */
  readonly fallback: CheckedCertificate
  /** The server sends the certificate beside each lowercase hostname to a client that sends that hostname. */
  readonly hostnames: readonly (readonly [string, CheckedCertificate])[]
}

function invalid(message: string): UhttpError {
  return new UhttpError('INVALID_SERVE_OPTIONS', message)
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkedFile(value: unknown, name: string, owner: string): string {
  if (typeof value !== 'string' || value === '') throw invalid(`Set ${owner}.${name} to the path of a PEM file.`)
  return value
}

function checkedCertificate(value: unknown, owner: string): CheckedCertificate {
  if (!isRecord(value)) throw invalid(`Pass ${owner} as an object with keyFile and certFile.`)
  const passphrase: unknown = Reflect.get(value, 'passphrase')
  if (passphrase !== undefined && typeof passphrase !== 'string') {
    throw invalid(`Set ${owner}.passphrase to a string, or leave it out for a key without one.`)
  }
  return {
    keyFile: checkedFile(Reflect.get(value, 'keyFile'), 'keyFile', owner),
    certFile: checkedFile(Reflect.get(value, 'certFile'), 'certFile', owner),
    passphrase,
  }
}

function isHostname(hostname: string): boolean {
  if (hostname.length > MAX_HOSTNAME_LENGTH) return false
  const labels = hostname.split('.')
  if (labels.length > MAX_HOSTNAME_LABELS) return false
  return labels.every((label, index) => (index === 0 && label === WILDCARD_LABEL) || HOSTNAME_LABEL.test(label))
}

function checkedHostnames(value: unknown): [string, CheckedCertificate][] {
  if (value === undefined) return []
  if (!isRecord(value)) throw invalid('Pass tls.hostnames as an object whose keys are hostnames.')
  const seen = new Set<string>()
  return Object.entries(value).map(([name, certificate]) => {
    const hostname = name.toLowerCase()
    if (!isHostname(hostname) || hostname === WILDCARD_LABEL) {
      throw invalid(`The key ${JSON.stringify(name)} of tls.hostnames is not a hostname such as api.example.com.`)
    }
    if (seen.has(hostname)) throw invalid(`The hostname ${hostname} appears more than once in tls.hostnames.`)
    seen.add(hostname)
    return [hostname, checkedCertificate(certificate, `tls.hostnames[${JSON.stringify(name)}]`)]
  })
}

function isCheckedCertificate(value: unknown): value is CheckedCertificate {
  if (!isRecord(value)) return false
  const passphrase: unknown = Reflect.get(value, 'passphrase')
  return (
    typeof Reflect.get(value, 'keyFile') === 'string' &&
    typeof Reflect.get(value, 'certFile') === 'string' &&
    (passphrase === undefined || typeof passphrase === 'string')
  )
}

function isHostnameEntry(value: unknown): value is readonly [string, CheckedCertificate] {
  return Array.isArray(value) && typeof value[0] === 'string' && isCheckedCertificate(value[1])
}

/**
 * Returns `true` when a value that a worker receives from the main thread has the shape of a
 * {@link CheckedTls}.
 *
 * @param value - The worker passes the value.
 * @returns The function returns `false` for any other value.
 * @internal
 */
export function isCheckedTls(value: unknown): value is CheckedTls {
  if (!isRecord(value)) return false
  const hostnames: unknown = Reflect.get(value, 'hostnames')
  return (
    isCheckedCertificate(Reflect.get(value, 'fallback')) && Array.isArray(hostnames) && hostnames.every(isHostnameEntry)
  )
}

/**
 * Returns the `tls` option of {@link serve} after the function checks its shape.
 *
 * @param value - The package passes the `tls` option that you gave to {@link serve}, which can be `undefined`.
 * @returns The function returns the checked option, or `undefined` when you leave the option out.
 * @throws {@link UhttpError} with the code `INVALID_SERVE_OPTIONS` for a file path that is not a
 * string, a passphrase that is not a string, or a key of `hostnames` that is not a hostname.
 * @internal
 */
export function checkedTls(value: unknown): CheckedTls | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid('Pass tls as an object with keyFile and certFile.')
  return {
    fallback: checkedCertificate(value, 'tls'),
    hostnames: checkedHostnames(Reflect.get(value, 'hostnames')),
  }
}
