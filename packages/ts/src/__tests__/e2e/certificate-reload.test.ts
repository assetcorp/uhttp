import { writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostCertificates, writeCertificate } from '../helpers/certificates.js'
import { type Host, reloadHost as reloaded, startHost, stateDirectory } from '../helpers/child.js'
import { requestHead } from '../helpers/http-client.js'
import { pause } from '../helpers/server.js'
import { fetchThread, openTlsConnection, type ThreadSeen, type TlsConnection } from '../helpers/tls-client.js'

const HOSTNAMES = ['api.test', 'www.test']
const STALL_AFTER_RELOAD_MS = 4_000

const PLAIN_CLOSE_WAIT_MS = 2_000

function tlsDirectory(): string {
  return hostCertificates(HOSTNAMES)
}

function plainReply(port: number): Promise<{ bytes: Buffer; closedWithinMs: number }> {
  const { promise, resolve } = Promise.withResolvers<{ bytes: Buffer; closedWithinMs: number }>()
  const sentAt = Date.now()
  const chunks: Buffer[] = []
  const socket = connect(port, '127.0.0.1', () => {
    socket.write(requestHead('GET', '/thread'))
  })
  const timer = setTimeout(() => socket.destroy(), PLAIN_CLOSE_WAIT_MS)
  socket.on('data', chunk => chunks.push(chunk))
  socket.on('error', () => undefined)
  socket.on('close', () => {
    clearTimeout(timer)
    resolve({ bytes: Buffer.concat(chunks), closedWithinMs: Date.now() - sentAt })
  })
  return promise
}

function tlsHost(directory: string, threads: string, env: Record<string, string> = {}): Promise<Host> {
  return startHost({
    UHTTP_THREADS: threads,
    UHTTP_TLS_DIR: directory,
    UHTTP_TLS_HOSTNAMES: HOSTNAMES.join(','),
    ...env,
  })
}

interface ClientReport {
  readonly sent: number
  readonly failures: string[]
  readonly commonNames: (string | undefined)[]
}

async function keepSending(port: number, servername: string, stop: () => boolean): Promise<ClientReport> {
  const report = { sent: 0, failures: [] as string[], commonNames: [] as (string | undefined)[] }
  let connection: TlsConnection | undefined
  let reused = false
  while (!stop()) {
    if (connection === undefined || connection.http.state !== 'open') {
      connection = await openTlsConnection(port, servername)
      report.commonNames.push(connection.commonName)
      reused = false
    }
    try {
      const response = await connection.http.exchange(requestHead('GET', '/slow/20'))
      if (response.status !== 200) report.failures.push(`status ${response.status}`)
      report.sent++
      reused = true
      if (response.headers.get('connection')?.includes('close')) connection = undefined
    } catch (error) {
      if (!reused) report.failures.push(String(error))
      connection = undefined
    }
  }
  return report
}

describe('a server with tls on worker threads', () => {
  it('serves HTTPS with the certificate of each hostname on every worker', async () => {
    const host = await tlsHost(tlsDirectory(), '2')
    const seen: ThreadSeen[] = []

    for (let index = 0; index < 8; index++) {
      for (const servername of [...HOSTNAMES, 'other.test']) seen.push(await fetchThread(host.port, servername))
    }

    expect(new Set(seen.map(entry => entry.thread)).size).toBe(2)
    expect(new Set(seen.map(entry => entry.commonName))).toEqual(new Set([...HOSTNAMES, 'default.test']))
  }, 30_000)
})

describe('server.reload() on worker threads', () => {
  it('serves new connections with the renewed certificates while every request that clients send during the reload succeeds', async () => {
    const directory = tlsDirectory()
    const host = await tlsHost(directory, '2')
    const seenBefore = await Promise.all([0, 1, 2, 3].map(() => fetchThread(host.port, 'api.test')))
    const before = new Set(seenBefore.map(seen => seen.thread))
    let stopped = false
    const clients = [...HOSTNAMES, 'other.test'].map(servername => keepSending(host.port, servername, () => stopped))
    await pause(300)

    writeCertificate(directory, 'default', 'renewed.test')
    for (const hostname of HOSTNAMES) writeCertificate(directory, hostname, `renewed.${hostname}`)
    expect(await reloaded(host)).toBe('reloaded')
    await pause(300)
    stopped = true
    const reports = await Promise.all(clients)
    const after = await Promise.all([...HOSTNAMES, 'other.test'].map(servername => fetchThread(host.port, servername)))

    expect(reports.flatMap(report => report.failures)).toEqual([])
    expect(reports.every(report => report.sent > 0)).toBe(true)
    expect(after.map(seen => seen.commonName)).toEqual(['renewed.api.test', 'renewed.www.test', 'renewed.test'])
    expect(after.some(seen => before.has(seen.thread))).toBe(false)
    expect(reports.map(report => report.commonNames.at(-1))).toEqual([
      'renewed.api.test',
      'renewed.www.test',
      'renewed.test',
    ])
    await host.close()
    expect((await host.exited).code).toBe(0)
  }, 40_000)

  it('closes each plain HTTP connection without an HTTP response while both workers serve TLS', async () => {
    const host = await tlsHost(tlsDirectory(), '2')
    const threads = new Set<string>()
    for (let attempt = 0; attempt < 6; attempt++) threads.add((await fetchThread(host.port, 'api.test')).thread)

    for (let attempt = 0; attempt < 6; attempt++) {
      const reply = await plainReply(host.port)
      expect(reply.closedWithinMs).toBeLessThan(PLAIN_CLOSE_WAIT_MS)
      expect(reply.bytes.subarray(0, 5).toString('latin1')).not.toBe('HTTP/')
    }

    expect(threads.size).toBe(2)
    await host.close()
    expect((await host.exited).code).toBe(0)
  }, 30_000)

  it('keeps serving with the old certificates when the renewed files are broken', async () => {
    const directory = tlsDirectory()
    const host = await tlsHost(directory, '2')

    writeFileSync(join(directory, 'api.test.key'), 'not a key')

    expect(await reloaded(host)).toBe('reload failed INVALID_CERTIFICATE')
    expect((await fetchThread(host.port, 'api.test')).commonName).toBe('api.test')
    await host.close()
    expect((await host.exited).code).toBe(0)
  }, 30_000)

  it('keeps serving with the old workers and logs the failure when a new worker fails to build the app', async () => {
    const state = stateDirectory()
    const host = await tlsHost(tlsDirectory(), '2', { UHTTP_FIXTURE_DIR: state })
    const before = await fetchThread(host.port, 'api.test')

    writeFileSync(join(state, 'fail-start'), '')

    expect(await reloaded(host)).toBe('reload failed APP_START_FAILED')
    const after = await Promise.all([0, 1, 2, 3].map(() => fetchThread(host.port, 'api.test')))
    expect(after.map(seen => seen.commonName)).toEqual(['api.test', 'api.test', 'api.test', 'api.test'])
    expect(after.some(seen => seen.thread === before.thread)).toBe(true)
    expect(host.output()).toContain('A worker thread failed to build the app.')
    await host.close()
    expect((await host.exited).code).toBe(0)
  }, 30_000)

  it('rejects a reload with SERVER_CLOSING once the server starts to close, and exits with code 0', async () => {
    const state = stateDirectory()
    const host = await tlsHost(tlsDirectory(), '2', { UHTTP_FIXTURE_DIR: state })
    writeFileSync(join(state, 'slow-start'), '')

    host.child.send('reload')
    await pause(500)
    host.child.send('close')

    expect(await reloaded(host)).toBe('reload failed SERVER_CLOSING')
    expect(await host.exited).toEqual({ code: 0, signal: null })
    expect(host.output()).toContain('closed')
  }, 30_000)

  it('closes an old connection whose request outlasts the grace period after a reload', async () => {
    const directory = tlsDirectory()
    const host = await tlsHost(directory, '2', { UHTTP_GRACE_PERIOD_MS: '400' })
    const old = await openTlsConnection(host.port, 'api.test')
    void old.http.write(requestHead('GET', '/slow/8000'))
    await pause(100)
    writeCertificate(directory, 'api.test', 'renewed.api.test')

    expect(await reloaded(host)).toBe('reloaded')
    const reloadedAt = Date.now()

    expect(['closed', 'reset']).toContain(await old.http.waitForClose(3_000))
    expect(Date.now() - reloadedAt).toBeLessThan(2_000)
    expect((await fetchThread(host.port, 'api.test')).commonName).toBe('renewed.api.test')
    await host.close()
    expect((await host.exited).code).toBe(0)
  }, 30_000)

  it('exits with an error when a worker that a reload retired blocks its thread', async () => {
    const host = await tlsHost(tlsDirectory(), '1', { UHTTP_WATCHDOG_MS: '600', UHTTP_GRACE_PERIOD_MS: '20000' })
    const old = await openTlsConnection(host.port, 'api.test')
    const sentAt = Date.now()
    void old.http.write(requestHead('GET', `/stall/${STALL_AFTER_RELOAD_MS}`))
    await pause(100)

    expect(await reloaded(host)).toBe('reloaded')
    expect(Date.now() - sentAt).toBeLessThan(STALL_AFTER_RELOAD_MS)
    const exit = await host.exited

    expect(exit).not.toEqual({ code: 0, signal: null })
    expect(host.output()).toContain('A worker thread sent no reply to a ping for 600 ms.')
    expect(host.output()).toContain('A worker thread hangs. The server exits with an error.')
  }, 30_000)
})
