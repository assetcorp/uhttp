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
    throw invalidCertificate(`The package could not load the key file or the certificate file of ${owner}.`, error)
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
 * Loads the key and the certificate at the top level and under every hostname, and checks that each
 * key decrypts with its passphrase and matches its certificate. uWebSockets.js skips, without an
 * error, a hostname whose files it fails to load, so the package checks every file before it
 * registers any certificate.
 *
 * @param tls - The package passes the checked `tls` option.
 * @returns The promise resolves once every key and every certificate passes the check.
 * @throws {@link UhttpError} with the code `INVALID_CERTIFICATE` for a file that the function fails
 * to load, a key that fails to decrypt, or a key that fails to match its certificate.
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
 * Returns an app of uWebSockets.js that serves HTTPS with the certificate at the top level, and
 * that sends the certificate of each hostname to a client that sends that hostname.
 *
 * @param uws - The package passes the module of uWebSockets.js.
 * @param tls - The package passes the checked `tls` option.
 * @param withHostnames - The package passes `false` for the app that only receives connections and
 * passes them to other apps.
 * @returns The function returns the app, which has no route yet.
 * @throws {@link UhttpError} with the code `INVALID_CERTIFICATE` when uWebSockets.js fails to load
 * the key and the certificate at the top level, such as when a file changes after the check.
 * @internal
 */
export function secureApp(uws: Uws, tls: CheckedTls, withHostnames: boolean): TemplatedApp {
  let native: TemplatedApp
  try {
    native = uws.SSLApp(appOptionsOf(tls.fallback))
  } catch (error) {
    throw invalidCertificate('uWebSockets.js could not load the key and the certificate of tls.', error)
  }
  if (!withHostnames) return native
  for (const [hostname, certificate] of tls.hostnames) native.addServerName(hostname, appOptionsOf(certificate))
  return native
}
