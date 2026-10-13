import type { AppOptions, TemplatedApp } from 'uWebSockets.js'
import { readFile } from 'node:fs/promises'
import { createSecureContext } from 'node:tls'
import { UhttpError } from '../errors.js'
import type { Uws } from './native.js'
import type { CheckedCertificate, CheckedTls } from './tls-options.js'

function invalidCertificate(message: string, cause: unknown): UhttpError {
  return new UhttpError('INVALID_CERTIFICATE', message, { cause })
}

async function checkCertificate(certificate: CheckedCertificate, owner: string): Promise<void> {
  let key: Buffer
  let cert: Buffer
  try {
    ;[key, cert] = await Promise.all([readFile(certificate.keyFile), readFile(certificate.certFile)])
  } catch (error) {
    throw invalidCertificate(`The package could not read the key file or the certificate file of ${owner}.`, error)
  }
  try {
    createSecureContext({ key, cert, passphrase: certificate.passphrase })
  } catch (error) {
    throw invalidCertificate(
      `The key of ${owner} fails to decrypt with its passphrase, or fails to match its certificate.`,
      error,
    )
  }
}

/**
 * Reads the key and the certificate of the default certificate and of every hostname, and checks
 * that each key decrypts with its passphrase and matches its certificate. uWebSockets.js skips a
 * hostname whose files it can't use without an error, so the package checks every file before it
 * registers any of them.
 *
 * @param tls - The package passes the checked `tls` option.
 * @returns The promise resolves once every key and every certificate has passed the check.
 * @throws {@link UhttpError} with the code `INVALID_CERTIFICATE` for a file that the package can't
 * read, a key that fails to decrypt, or a key that fails to match its certificate.
 * @internal
 */
export async function checkCertificates(tls: CheckedTls): Promise<void> {
  await checkCertificate(tls.fallback, 'tls')
  for (const [hostname, certificate] of tls.hostnames) {
    await checkCertificate(certificate, `the hostname ${hostname}`)
  }
}

function appOptionsOf(certificate: CheckedCertificate): AppOptions {
  const { keyFile, certFile, passphrase } = certificate
  return passphrase === undefined
    ? { key_file_name: keyFile, cert_file_name: certFile }
    : { key_file_name: keyFile, cert_file_name: certFile, passphrase }
}

/**
 * Returns an app of uWebSockets.js that serves HTTPS with the default certificate, and with the
 * certificate of each hostname for a client that names it.
 *
 * @param uws - The package passes the module of uWebSockets.js.
 * @param tls - The package passes the checked `tls` option.
 * @param withHostnames - The package passes `false` for the app that only accepts connections and
 * passes them to other apps.
 * @returns The function returns the app, on which the package has registered no route.
 * @throws {@link UhttpError} with the code `INVALID_CERTIFICATE` when uWebSockets.js can't use the
 * default key and certificate, such as after a file changed since the check.
 * @internal
 */
export function secureApp(uws: Uws, tls: CheckedTls, withHostnames: boolean): TemplatedApp {
  let native: TemplatedApp
  try {
    native = uws.SSLApp(appOptionsOf(tls.fallback))
  } catch (error) {
    throw invalidCertificate('uWebSockets.js could not use the key and the certificate of tls.', error)
  }
  if (!withHostnames) return native
  for (const [hostname, certificate] of tls.hostnames) native.addServerName(hostname, appOptionsOf(certificate))
  return native
}
