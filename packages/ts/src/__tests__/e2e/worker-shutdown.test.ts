import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startHost, waitFor } from '../helpers/child.js'
import { type HttpConnection, openConnection, requestHead } from '../helpers/http-client.js'
import { pause } from '../helpers/server.js'
import { openSocket } from '../helpers/websocket.js'

const LOOPBACK = '127.0.0.1'
const DRAIN_MESSAGE_WAIT_MS = 150

async function threadOf(connection: HttpConnection): Promise<string> {
  return (await connection.exchange(requestHead('GET', '/thread'))).body.toString()
}

async function twoThreads(port: number): Promise<[HttpConnection, HttpConnection]> {
  const first = await openConnection(port)
  const firstThread = await threadOf(first)
  for (let attempt = 0; attempt < 20; attempt++) {
    const second = await openConnection(port)
    if ((await threadOf(second)) !== firstThread) return [first, second]
    second.destroy()
  }
  throw new Error('Every connection reached the same thread.')
}

function refused(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ port, host: LOOPBACK })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
  })
}

async function listenerClosed(port: number): Promise<void> {
  await waitFor(async () => ((await refused(port)) ? true : undefined), 5_000, 'Closing the listening socket')
  await pause(DRAIN_MESSAGE_WAIT_MS)
}

describe('server.close() on worker threads', () => {
  it('lets a request in progress on a worker finish, sends a 503 in response to a new request, and exits with code 0', async () => {
    const host = await startHost({ UHTTP_THREADS: '1' })
    const busy = await openConnection(host.port)
    const idle = await openConnection(host.port)
    await threadOf(idle)
    void busy.write(requestHead('GET', '/slow/1200'))
    await pause(100)

    host.child.send('close')
    await listenerClosed(host.port)
    const refusedResponse = await idle.exchange(requestHead('GET', '/thread'))
    const finished = await busy.response({ waitMs: 3_000 })

    expect(refusedResponse.status).toBe(503)
    expect(refusedResponse.headers.get('connection')).toEqual(['close'])
    expect(JSON.parse(refusedResponse.body.toString())).toMatchObject({ error: { code: 'SERVER_CLOSING' } })
    expect(finished.status).toBe(200)
    expect(finished.body.toString()).toMatch(/^slow from thread \d+$/)
    expect(finished.headers.get('connection')).toEqual(['close'])
    expect(await host.exited).toEqual({ code: 0, signal: null })
    expect(host.output()).toContain('closed')
  }, 20_000)

  it('closes the connections that are left on a worker once the grace period ends, and exits with code 0', async () => {
    const host = await startHost({ UHTTP_THREADS: '2', UHTTP_GRACE_PERIOD_MS: '400' })
    const busy = await openConnection(host.port)
    void busy.write(requestHead('GET', '/slow/8000'))
    await pause(100)
    const startedAt = Date.now()

    host.child.send('close')

    expect(await host.exited).toEqual({ code: 0, signal: null })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(380)
    expect(Date.now() - startedAt).toBeLessThan(4_000)
    expect(['closed', 'reset']).toContain(await busy.waitForClose())
  }, 20_000)

  it('waits for a request in progress on a worker when the grace period is at its maximum of 2147483647 ms', async () => {
    const host = await startHost({ UHTTP_THREADS: '1', UHTTP_GRACE_PERIOD_MS: '2147483647' })
    const busy = await openConnection(host.port)
    void busy.write(requestHead('GET', '/slow/1000'))
    await pause(100)

    host.child.send('close')
    await pause(500)
    const closedEarly = host.output().includes('closed')
    const finished = await busy.response({ waitMs: 3_000 })

    expect(closedEarly).toBe(false)
    expect(finished.status).toBe(200)
    expect(await host.exited).toEqual({ code: 0, signal: null })
    expect(host.output()).toContain('closed')
    expect(host.output()).not.toContain('TimeoutOverflowWarning')
  }, 20_000)

  it('lets the process end after the grace period and the exit wait when a worker blocks its thread during the close', async () => {
    const host = await startHost({ UHTTP_THREADS: '1', UHTTP_WATCHDOG_MS: '0', UHTTP_GRACE_PERIOD_MS: '300' })
    const busy = await openConnection(host.port)
    void busy.write(requestHead('GET', '/stall/200'))
    await pause(50)
    const startedAt = Date.now()

    host.child.send('close')
    await host.exited

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_000)
    expect(host.output()).toContain('closed')
    expect(host.output()).toContain(
      'A worker thread is alive after the close, so the main thread stops waiting for it.',
    )
  }, 20_000)
})

describe('the process exit hook of a server on worker threads', () => {
  it('waits until every worker closes its connections when the host process calls process.exit()', async () => {
    const host = await startHost({ UHTTP_THREADS: '2' })
    const [first, second] = await twoThreads(host.port)
    const socket = await openSocket(host.port, '/chat/lobby')
    await socket.nextMessage()

    host.child.send('exit')

    expect(await host.exited).toEqual({ code: 0, signal: null })
    expect(await first.waitForClose()).not.toBe('open')
    expect(await second.waitForClose()).not.toBe('open')
    expect((await socket.closed).code).toBe(1006)
  }, 20_000)

  it('drains the healthy workers before it exits with an error when a worker hangs, without waiting for the hung worker', async () => {
    const host = await startHost({ UHTTP_THREADS: '2', UHTTP_WATCHDOG_MS: '600', UHTTP_GRACE_PERIOD_MS: '6000' })
    const [healthy, doomed] = await twoThreads(host.port)
    const startedAt = Date.now()

    void healthy.write(requestHead('GET', '/slow/1500'))
    await doomed.exchange(requestHead('GET', '/hang'))
    const finished = await healthy.response({ waitMs: 5_000 })
    const exit = await host.exited

    expect(finished.status).toBe(200)
    expect(finished.headers.get('connection')).toEqual(['close'])
    expect(exit).toEqual({ code: null, signal: 'SIGABRT' })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(host.output()).toContain('A worker thread sent no reply to a ping for 600 ms.')
    expect(host.output()).toContain('A worker thread hangs. The server exits with an error.')
  }, 20_000)
})
