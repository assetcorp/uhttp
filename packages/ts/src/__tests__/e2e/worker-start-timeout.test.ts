import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serve } from '../../index.js'
import { hostCertificates } from '../helpers/certificates.js'
import { reloadHost, startEvents, startHost, stateDirectory, waitFor } from '../helpers/child.js'
import { openConnection, requestHead } from '../helpers/http-client.js'
import { track } from '../helpers/server.js'
import { fetchThread } from '../helpers/tls-client.js'

const START_TIMEOUT_MS = 1_000
const SLOW_START_MS = 3_000
const fixture = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url)

function eventsIn(directory: string): string[] {
  return startEvents(directory).map(entry => entry.event)
}

async function serveWith(directory: string, trigger: string, workerStartTimeoutMs: number) {
  writeFileSync(join(directory, trigger), '')
  process.env.UHTTP_FIXTURE_DIR = directory
  try {
    return await serve({ app: fixture('thread-app.js'), port: 0, host: '127.0.0.1', threads: 2, workerStartTimeoutMs })
  } finally {
    delete process.env.UHTTP_FIXTURE_DIR
  }
}

describe('a worker thread that takes too long to build its app', () => {
  it('makes serve() reject with APP_START_FAILED once workerStartTimeoutMs passes', async () => {
    const directory = stateDirectory()
    const startedAt = Date.now()

    await expect(serveWith(directory, 'hang-start', START_TIMEOUT_MS)).rejects.toMatchObject({
      code: 'APP_START_FAILED',
      cause: expect.objectContaining({
        message: `The worker thread took longer than ${START_TIMEOUT_MS} ms to build its app.`,
      }),
    })

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(START_TIMEOUT_MS)
    expect(Date.now() - startedAt).toBeLessThan(START_TIMEOUT_MS + 4_000)
    expect(eventsIn(directory)).toEqual(['hang', 'hang'])
  }, 20_000)

  it('makes serve() reject with APP_START_FAILED when a worker waits for its pub/sub adapter after it creates its app', async () => {
    const directory = stateDirectory()

    await expect(serveWith(directory, 'hang-adapter', START_TIMEOUT_MS)).rejects.toMatchObject({
      code: 'APP_START_FAILED',
      cause: expect.objectContaining({
        message: `The worker thread took longer than ${START_TIMEOUT_MS} ms to build its app.`,
      }),
    })
  }, 20_000)

  it('serves once every worker builds its app inside the limit, or with the limit at 0', async () => {
    for (const workerStartTimeoutMs of [SLOW_START_MS * 3, 0]) {
      const directory = stateDirectory()
      const server = track(await serveWith(directory, 'slow-start', workerStartTimeoutMs))
      const response = await (await openConnection(server.port)).exchange(requestHead('GET', '/thread'))

      expect(response.status).toBe(200)
      expect(eventsIn(directory)).toEqual(['slow', 'slow', 'start', 'start'])
      await server.close()
    }
  }, 30_000)

  it('makes server.reload() reject with APP_START_FAILED while the old workers go on serving, and lets the server close', async () => {
    const directory = stateDirectory()
    const host = await startHost({
      UHTTP_FIXTURE_DIR: directory,
      UHTTP_THREADS: '2',
      UHTTP_TLS_DIR: hostCertificates(['api.test']),
      UHTTP_TLS_HOSTNAMES: 'api.test',
      UHTTP_WORKER_START_TIMEOUT_MS: String(START_TIMEOUT_MS),
    })
    const before = new Set<string>()
    for (let request = 0; request < 3; request++) before.add((await fetchThread(host.port, 'api.test')).thread)
    writeFileSync(join(directory, 'hang-start'), '')
    const reloadedAt = Date.now()

    expect(await reloadHost(host)).toBe('reload failed APP_START_FAILED')
    expect(Date.now() - reloadedAt).toBeLessThan(START_TIMEOUT_MS + 4_000)
    for (let request = 0; request < 4; request++) {
      expect(before.has((await fetchThread(host.port, 'api.test')).thread)).toBe(true)
    }
    expect(eventsIn(directory).filter(event => event === 'hang')).toHaveLength(2)

    const closedAt = Date.now()
    await host.close()
    expect(await host.exited).toEqual({ code: 0, signal: null })
    expect(Date.now() - closedAt).toBeLessThan(4_000)
  }, 30_000)

  it('logs a replacement that takes too long, and starts another one while the other worker serves', async () => {
    const directory = stateDirectory()
    const host = await startHost({
      UHTTP_FIXTURE_DIR: directory,
      UHTTP_THREADS: '2',
      UHTTP_WORKER_START_TIMEOUT_MS: String(START_TIMEOUT_MS),
      UHTTP_CRASH_LIMIT: '100',
    })
    writeFileSync(join(directory, 'hang-start'), '')

    await (await openConnection(host.port)).exchange(requestHead('GET', '/crash'))
    await waitFor(
      () => (eventsIn(directory).filter(event => event === 'hang').length >= 2 ? true : undefined),
      START_TIMEOUT_MS * 4 + 5_000,
      'A second start of the replacement',
    )

    expect(host.output()).toContain('A worker thread took too long to build its app.')
    const response = await (await openConnection(host.port)).exchange(requestHead('GET', '/thread'))
    expect(response.status).toBe(200)
    await host.close()
    expect(await host.exited).toEqual({ code: 0, signal: null })
  }, 30_000)

  it('counts a replacement that takes too long as a crash, so the server exits with code 1 at the crash limit', async () => {
    const directory = stateDirectory()
    const host = await startHost({
      UHTTP_FIXTURE_DIR: directory,
      UHTTP_THREADS: '2',
      UHTTP_WORKER_START_TIMEOUT_MS: String(START_TIMEOUT_MS),
      UHTTP_CRASH_LIMIT: '2',
      UHTTP_CRASH_WINDOW_MS: '60000',
    })
    writeFileSync(join(directory, 'hang-start'), '')

    await (await openConnection(host.port)).exchange(requestHead('GET', '/crash'))

    expect((await host.exited).code).toBe(1)
    expect(host.output()).toContain('A worker thread took too long to build its app.')
    expect(host.output()).toContain('Worker threads crashed 2 times within 60000 ms. The server exits with an error.')
  }, 30_000)
})
