import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface CertificateFiles {
  keyFile: string
  certFile: string
}

export function certificateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'uhttp-tls-'))
}

export function writeCertificate(
  directory: string,
  name: string,
  commonName: string,
  passphrase?: string,
): CertificateFiles {
  const keyFile = join(directory, `${name}.key`)
  const certFile = join(directory, `${name}.crt`)
  const keyArguments = passphrase === undefined ? ['-nodes'] : ['-passout', `pass:${passphrase}`]
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      ...keyArguments,
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '2',
      '-subj',
      `/CN=${commonName}`,
      '-addext',
      `subjectAltName=DNS:${commonName}`,
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`openssl could not write a certificate: ${result.stderr}`)
  return { keyFile, certFile }
}
