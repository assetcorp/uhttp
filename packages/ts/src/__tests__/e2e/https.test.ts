import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { createApp, serve } from '../../index.js'
import { certificateDirectory, writeCertificate } from '../helpers/certificates.js'
import { HttpConnection, openConnection, requestHead } from '../helpers/http-client.js'
import { pause, track } from '../helpers/server.js'
import { openTlsConnection } from '../helpers/tls-client.js'
import { handshakeHeaders, upgradeHead } from '../helpers/websocket.js'

const HOST = '127.0.0.1'

function routedApp() {
  return createApp()
    .get('/name', c => c.text('named'))
    .get('/users/:id', c => c.text(`user ${c.req.param('id')}`))
    .get('/slow', async c => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return c.text('slow')
    })
    .ws('/live', {})
}

function certificates() {
  const directory = certificateDirectory()
  return {
    directory,
    fallback: writeCertificate(directory, 'default', 'default.test'),
    api: writeCertificate(directory, 'api', 'api.test'),
    www: writeCertificate(directory, 'www', 'www.test'),
  }
}

async function get(port: number, servername: string, target: string) {
  const connection = await openTlsConnection(port, servername)
  const response = await connection.http.exchange(requestHead('GET', target))
  return { commonName: connection.commonName, status: response.status, body: response.body.toString() }
}

describe('a server with tls', () => {
  it('serves HTTPS with the default certificate to a client that sends a hostname outside tls.hostnames', async () => {
    const { fallback } = certificates()
    const server = track(await serve({ app: routedApp(), port: 0, host: HOST, tls: fallback }))

    expect(await get(server.port, 'unknown.test', '/name')).toEqual({
      commonName: 'default.test',
      status: 200,
      body: 'named',
    })
  })

  it('serves every route under each hostname with the certificate of that hostname', async () => {
    const { fallback, api, www } = certificates()
    const tls = { ...fallback, hostnames: { 'api.test': api, 'WWW.Test': www } }
    const server = track(await serve({ app: routedApp(), port: 0, host: HOST, tls }))

    for (const hostname of ['api.test', 'www.test']) {
      expect(await get(server.port, hostname, '/name')).toEqual({ commonName: hostname, status: 200, body: 'named' })
      expect(await get(server.port, hostname, '/users/42')).toMatchObject({ status: 200, body: 'user 42' })
      expect(await get(server.port, hostname, '/missing')).toMatchObject({ commonName: hostname, status: 404 })
    }
    expect(await get(server.port, 'other.test', '/users/7')).toMatchObject({
      commonName: 'default.test',
      body: 'user 7',
    })
  })

  it('switches a connection under a hostname to a WebSocket', async () => {
    const { fallback, api } = certificates()
    const server = track(
      await serve({ app: routedApp(), port: 0, host: HOST, tls: { ...fallback, hostnames: { 'api.test': api } } }),
    )
    const connection = await openTlsConnection(server.port, 'api.test')

    void connection.http.write(upgradeHead('/live', handshakeHeaders()))

    expect(await connection.http.interim()).toBe(101)
  })

  it('loads a key that a passphrase encrypts', async () => {
    const directory = certificateDirectory()
    const locked = writeCertificate(directory, 'locked', 'locked.test', 'open sesame')
    const server = track(
      await serve({ app: routedApp(), port: 0, host: HOST, tls: { ...locked, passphrase: 'open sesame' } }),
    )

    expect(await get(server.port, 'locked.test', '/name')).toMatchObject({ commonName: 'locked.test', body: 'named' })
  })

  it('sends no HTTP response to a plain HTTP request on a port that serves HTTPS', async () => {
    const { fallback } = certificates()
    const server = track(await serve({ app: routedApp(), port: 0, host: HOST, tls: fallback }))
    const connection = await openConnection(server.port)

    void connection.write(requestHead('GET', '/name'))

    await expect(connection.response()).rejects.toThrow()
  })

  it('serves HTTPS on a Unix socket', async () => {
    const { fallback } = certificates()
    const path = join(mkdtempSync(join(tmpdir(), 'uhttp-unix-')), 'server.sock')
    const server = await serve({ app: routedApp(), path, tls: fallback })
    const socket = connect({ path, servername: 'default.test', rejectUnauthorized: false })
    const connection = new HttpConnection(socket)

    const response = await connection.exchange(requestHead('GET', '/name'))

    expect(response.body.toString()).toBe('named')
    expect(socket.getPeerCertificate().subject?.CN).toBe('default.test')
    socket.destroy()
    await server.close()
  })
})

describe('the certificates of a server with tls', () => {
  it('rejects with INVALID_CERTIFICATE when a key or a certificate is missing, mismatched, or locked by another passphrase', async () => {
    const { directory, fallback, api } = certificates()
    const locked = writeCertificate(directory, 'locked', 'locked.test', 'open sesame')
    const garbage = join(directory, 'garbage.pem')
    writeFileSync(garbage, 'not a certificate')
    const missing = join(directory, 'missing.pem')
    const broken = [
      { ...fallback, keyFile: missing },
      { ...fallback, certFile: missing },
      { ...fallback, certFile: garbage },
      { keyFile: fallback.keyFile, certFile: api.certFile },
      { ...locked },
      { ...locked, passphrase: 'wrong' },
    ]
    const tlsOptions = [
      ...broken,
      ...broken.map(certificate => ({ ...fallback, hostnames: { 'api.test': certificate } })),
    ]

    for (const tls of tlsOptions) {
      await expect(serve({ app: routedApp(), port: 0, host: HOST, tls }), JSON.stringify(tls)).rejects.toMatchObject({
        code: 'INVALID_CERTIFICATE',
      })
    }
  })

  it('throws INVALID_SERVE_OPTIONS for tls options of the wrong shape', async () => {
    const { fallback } = certificates()
    const invalid: unknown[] = [
      'cert.pem',
      { keyFile: fallback.keyFile },
      { certFile: fallback.certFile },
      { ...fallback, keyFile: 1 },
      { ...fallback, keyFile: '' },
      { ...fallback, passphrase: 5 },
      { ...fallback, hostnames: [] },
      { ...fallback, hostnames: { 'api.test': 'cert.pem' } },
      { ...fallback, hostnames: { 'bad host': fallback } },
      { ...fallback, hostnames: { '': fallback } },
      { ...fallback, hostnames: { 'api..test': fallback } },
      { ...fallback, hostnames: { '*.*.test': fallback } },
      { ...fallback, hostnames: { 'API.test': fallback, 'api.test': fallback } },
    ]

    for (const tls of invalid) {
      await expect(
        Reflect.apply(serve, undefined, [{ app: routedApp(), port: 0, host: HOST, tls }]),
        JSON.stringify(tls),
      ).rejects.toMatchObject({ code: 'INVALID_SERVE_OPTIONS' })
    }
  })
})

describe('server.reload() on the main thread', () => {
  it('serves new connections with the renewed certificate, lets a request on an old connection finish, and closes the idle old ones', async () => {
    const { directory, fallback } = certificates()
    const server = await serve({ app: routedApp(), port: 0, host: HOST, tls: fallback })
    const port = server.port ?? 0
    const busy = await openTlsConnection(port, 'default.test')
    const idle = await openTlsConnection(port, 'default.test')
    expect((await idle.http.exchange(requestHead('GET', '/name'))).status).toBe(200)
    void busy.http.write(requestHead('GET', '/slow'))
    await pause(50)

    writeCertificate(directory, 'default', 'renewed.test')
    await server.reload()
    const renewed = await get(port, 'default.test', '/users/9')
    const lastOnOld = await busy.http.response()

    expect(renewed).toEqual({ commonName: 'renewed.test', status: 200, body: 'user 9' })
    expect(busy.commonName).toBe('default.test')
    expect(lastOnOld.body.toString()).toBe('slow')
    expect(lastOnOld.headers.get('connection')).toEqual(['close'])
    expect(await busy.http.waitForClose()).toBe('closed')
    expect(await idle.http.waitForClose()).toBe('closed')
    await server.close()
  })

  it('rejects with INVALID_CERTIFICATE and keeps the old certificate when the renewed files are broken', async () => {
    const { directory, fallback } = certificates()
    const server = await serve({ app: routedApp(), port: 0, host: HOST, tls: fallback })
    const port = server.port ?? 0

    writeFileSync(join(directory, 'default.key'), 'not a key')

    await expect(server.reload()).rejects.toMatchObject({ code: 'INVALID_CERTIFICATE' })
    expect(await get(port, 'default.test', '/name')).toMatchObject({ commonName: 'default.test', body: 'named' })
    await server.close()
  })

  it('rejects with INVALID_SERVE_OPTIONS on a server without tls', async () => {
    const server = await serve({ app: routedApp(), port: 0, host: HOST })

    await expect(server.reload()).rejects.toMatchObject({ code: 'INVALID_SERVE_OPTIONS' })
    await server.close()
  })
})
