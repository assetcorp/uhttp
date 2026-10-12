import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serve } from '../../index.js'
import { startHost, stateDirectory, waitFor } from '../helpers/child.js'
import { type HttpConnection, openConnection, requestHead } from '../helpers/http-client.js'
import { pause, track } from '../helpers/server.js'
import { openSocket } from '../helpers/websocket.js'

const fixture = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url)

async function threadOf(connection: HttpConnection): Promise<string> {
  const response = await connection.exchange(requestHead('GET', '/thread'))
  return response.body.toString()
}

async function connectionTo(port: number, thread: string, attempts = 20): Promise<HttpConnection> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const connection = await openConnection(port)
    if ((await threadOf(connection)) === thread) return connection
    connection.destroy()
  }
  throw new Error(`No connection reached thread ${thread}.`)
}

async function threadsSeen(port: number, connections: number): Promise<Set<string>> {
  const seen = new Set<string>()
  for (let index = 0; index < connections; index++) {
    const connection = await openConnection(port)
    seen.add(await threadOf(connection))
    connection.destroy()
  }
  return seen
}

function starts(directory: string): { time: number; thread: string; event: string }[] {
  return readFileSync(join(directory, 'starts'), 'utf8')
    .trim()
    .split('\n')
    .map(line => {
      const [time = '0', thread = '', event = ''] = line.split(' ')
      return { time: Number(time), thread, event }
    })
}

describe('a server on worker threads', () => {
  it('spreads connections over every worker, and executes the host script once on the main thread', async () => {
    const directory = stateDirectory()
    const host = await startHost({ UHTTP_FIXTURE_DIR: directory, UHTTP_THREADS: '3' })

    const seen = await threadsSeen(host.port, 9)

    expect(seen.size).toBe(3)
    expect([...seen].every(thread => thread !== '0')).toBe(true)
    expect(readFileSync(join(directory, 'host'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(starts(directory).map(entry => entry.event)).toEqual(['start', 'start', 'start'])
    await host.close()
    expect((await host.exited).code).toBe(0)
  })

  it('serves every request on the main thread with threads at 0', async () => {
    const server = track(await serve({ app: fixture('thread-app.js'), port: 0, host: '127.0.0.1', threads: 0 }))

    expect(await threadsSeen(server.port, 3)).toEqual(new Set(['0']))
  })

  it('rejects with APP_START_FAILED when the app module throws during the first start, and starts no server', async () => {
    const directory = stateDirectory()
    writeFileSync(join(directory, 'fail-start'), '')
    process.env.UHTTP_FIXTURE_DIR = directory
    try {
      await expect(
        serve({ app: fixture('thread-app.js'), port: 0, host: '127.0.0.1', threads: 2 }),
      ).rejects.toMatchObject({
        code: 'APP_START_FAILED',
        cause: expect.objectContaining({
          code: 'APP_START_FAILED',
          cause: expect.objectContaining({ message: 'The fixture refuses to build its app.' }),
        }),
      })
    } finally {
      delete process.env.UHTTP_FIXTURE_DIR
    }
  })

  it('rejects with APP_START_FAILED when a worker crashes after it serves and before the other workers serve', async () => {
    const directory = stateDirectory()
    writeFileSync(join(directory, 'crash-after-start'), '')
    writeFileSync(join(directory, 'slow-start'), '')
    process.env.UHTTP_FIXTURE_DIR = directory
    try {
      await expect(
        serve({ app: fixture('thread-app.js'), port: 0, host: '127.0.0.1', threads: 2 }),
      ).rejects.toMatchObject({
        code: 'APP_START_FAILED',
        cause: expect.objectContaining({ message: 'The fixture crashed on purpose after it started.' }),
      })
    } finally {
      delete process.env.UHTTP_FIXTURE_DIR
    }
  })

  it('answers 503 while every worker that is left is still building its app', async () => {
    const directory = stateDirectory()
    const host = await startHost({ UHTTP_FIXTURE_DIR: directory, UHTTP_THREADS: '2' })
    const [first, second] = [...(await threadsSeen(host.port, 4))]
    if (first === undefined || second === undefined) throw new Error('The host started fewer than two workers.')

    writeFileSync(join(directory, 'slow-start'), '')
    await (await connectionTo(host.port, first)).exchange(requestHead('GET', '/crash'))
    await waitFor(
      () => (starts(directory).some(entry => entry.event === 'slow') ? true : undefined),
      5_000,
      'A slow start',
    )
    await (await connectionTo(host.port, second)).exchange(requestHead('GET', '/crash'))
    await pause(100)
    const response = await (await openConnection(host.port)).exchange(requestHead('GET', '/thread'))

    expect(response.status).toBe(503)
    expect(response.body.toString()).toBe('No worker thread can serve this request.')
    await waitFor(
      async () => ((await threadsSeen(host.port, 1)).size === 1 ? true : undefined),
      10_000,
      'Serving after the slow start',
    )
  }, 30_000)

  it('keeps serving on the other workers after a worker crashes while it has an open connection', async () => {
    const directory = stateDirectory()
    const host = await startHost({ UHTTP_FIXTURE_DIR: directory, UHTTP_THREADS: '2' })
    const doomed = await openConnection(host.port)
    const doomedThread = await threadOf(doomed)
    const held = await openConnection(host.port)
    void held

    await doomed.exchange(requestHead('GET', '/crash'))
    await pause(100)
    const during = await threadsSeen(host.port, 6)

    expect(during.has(doomedThread)).toBe(false)
    expect(during.size).toBe(1)
    expect(host.output()).toContain('A worker thread crashed.')
    expect(host.output()).toContain('The fixture crashed on purpose.')
    await waitFor(
      async () => ((await threadsSeen(host.port, 4)).size === 2 ? true : undefined),
      5_000,
      'Serving on a replacement',
    )
    expect(starts(directory)).toHaveLength(3)
    await host.close()
    expect((await host.exited).code).toBe(0)
  })

  it('closes the connections on every worker and exits cleanly when the host closes the server', async () => {
    const host = await startHost({ UHTTP_THREADS: '2' })
    const connections = await Promise.all([0, 1, 2, 3].map(() => openConnection(host.port)))
    const threads = new Set(await Promise.all(connections.map(threadOf)))
    const socket = await openSocket(host.port, '/chat/lobby')
    await socket.nextMessage()
    expect(threads.size).toBe(2)

    await host.close()

    expect(await host.exited).toEqual({ code: 0, signal: null })
    expect((await socket.closed).code).toBe(1006)
    expect(await Promise.all(connections.map(connection => connection.waitForClose()))).toEqual([
      'closed',
      'closed',
      'closed',
      'closed',
    ])
  })

  it('replaces a worker whose promise rejects without a handler', async () => {
    const directory = stateDirectory()
    const host = await startHost({ UHTTP_FIXTURE_DIR: directory, UHTTP_THREADS: '2' })
    const connection = await openConnection(host.port)

    await connection.exchange(requestHead('GET', '/reject'))

    await waitFor(() => (starts(directory).length === 3 ? true : undefined), 5_000, 'The replacement start')
    expect(host.output()).toContain('The fixture rejected on purpose.')
  })

  it('starts a replacement after 1 second and doubles the delay while each replacement fails to build its app', async () => {
    const directory = stateDirectory()
    const host = await startHost({ UHTTP_FIXTURE_DIR: directory, UHTTP_THREADS: '2', UHTTP_CRASH_LIMIT: '100' })
    const connection = await openConnection(host.port)

    writeFileSync(join(directory, 'fail-start'), '')
    const crashedAt = Date.now()
    await connection.exchange(requestHead('GET', '/crash'))
    await waitFor(() => (starts(directory).length >= 5 ? true : undefined), 15_000, 'Three failed replacements')

    const failures = starts(directory).slice(2)
    const gaps = [failures[0], failures[1], failures[2]].map((entry, index) => {
      const previous = index === 0 ? crashedAt : (failures[index - 1]?.time ?? 0)
      return (entry?.time ?? 0) - previous
    })
    expect(failures.slice(0, 3).map(entry => entry.event)).toEqual(['fail', 'fail', 'fail'])
    expect(gaps[0]).toBeGreaterThanOrEqual(950)
    expect(gaps[0]).toBeLessThan(1_800)
    expect(gaps[1]).toBeGreaterThanOrEqual(1_950)
    expect(gaps[1]).toBeLessThan(2_800)
    expect(gaps[2]).toBeGreaterThanOrEqual(3_950)
    expect(gaps[2]).toBeLessThan(4_800)
    expect(await threadsSeen(host.port, 2)).toHaveProperty('size', 1)
  }, 30_000)

  it('resets the delay to 1 second once a replacement has served for 30 seconds', async () => {
    const directory = stateDirectory()
    const host = await startHost({ UHTTP_FIXTURE_DIR: directory, UHTTP_THREADS: '2' })
    const [first, second] = [...(await threadsSeen(host.port, 4))]
    if (first === undefined || second === undefined) throw new Error('The host started fewer than two workers.')

    await (await connectionTo(host.port, first)).exchange(requestHead('GET', '/crash'))
    await waitFor(() => (starts(directory).length === 3 ? true : undefined), 5_000, 'The first replacement')
    await pause(200)
    await (await connectionTo(host.port, second)).exchange(requestHead('GET', '/crash'))
    await waitFor(() => (starts(directory).length === 4 ? true : undefined), 5_000, 'The second replacement')
    await pause(31_000)
    const crashedAt = Date.now()
    await (await openConnection(host.port)).exchange(requestHead('GET', '/crash'))
    await waitFor(() => (starts(directory).length === 5 ? true : undefined), 5_000, 'The third replacement')

    const gap = (starts(directory)[4]?.time ?? 0) - crashedAt
    expect(gap).toBeGreaterThanOrEqual(950)
    expect(gap).toBeLessThan(1_800)
  }, 60_000)

  it('logs the hang and ends the process when a worker that has an open connection fails to answer for the watchdog timeout', async () => {
    const host = await startHost({ UHTTP_THREADS: '2', UHTTP_WATCHDOG_MS: '600' })
    const connection = await openConnection(host.port)
    const startedAt = Date.now()

    await connection.exchange(requestHead('GET', '/hang'))
    const exit = await host.exited

    expect(exit).toEqual({ code: null, signal: 'SIGABRT' })
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(host.output()).toContain('A worker thread failed to answer for 600 ms.')
    expect(host.output()).toContain('A worker thread hangs. The server exits with an error.')
  }, 20_000)

  it('keeps the process alive for 3 seconds after a worker hangs when the watchdog timeout is 0', async () => {
    const host = await startHost({ UHTTP_THREADS: '2', UHTTP_WATCHDOG_MS: '0' })
    const connection = await openConnection(host.port)

    await connection.exchange(requestHead('GET', '/hang'))
    const outcome = await Promise.race([host.exited, pause(3_000).then(() => 'alive')])

    expect(outcome).toBe('alive')
    expect(host.output()).not.toContain('failed to answer')
  }, 20_000)

  it('ends the process when a worker that has an open connection passes its heap limit', async () => {
    const host = await startHost({ UHTTP_THREADS: '2', UHTTP_WORKER_HEAP_MB: '32' })
    const connection = await openConnection(host.port)

    await connection.exchange(requestHead('GET', '/allocate'))

    expect(await host.exited).toEqual({ code: null, signal: 'SIGABRT' })
  }, 30_000)

  it('exits with an error when every worker is dead', async () => {
    const host = await startHost({ UHTTP_THREADS: '1' })
    const connection = await openConnection(host.port)

    await connection.exchange(requestHead('GET', '/crash'))

    expect((await host.exited).code).toBe(1)
    expect(host.output()).toContain('Every worker thread is dead. The server exits with an error.')
  }, 20_000)

  it('exits with an error once workers crash as often as the crash limit within its window', async () => {
    const host = await startHost({ UHTTP_THREADS: '3', UHTTP_CRASH_LIMIT: '2', UHTTP_CRASH_WINDOW_MS: '5000' })
    const [first, second] = [...(await threadsSeen(host.port, 6))]

    await (await connectionTo(host.port, first ?? '')).exchange(requestHead('GET', '/crash'))
    await (await connectionTo(host.port, second ?? '')).exchange(requestHead('GET', '/crash'))

    expect((await host.exited).code).toBe(1)
    expect(host.output()).toContain('Worker threads crashed 2 times within 5000 ms. The server exits with an error.')
  }, 20_000)

  it('limits the heap of each worker through workerHeapMb', async () => {
    const limited = await startHost({ UHTTP_THREADS: '1', UHTTP_WORKER_HEAP_MB: '32' })
    const unlimited = await startHost({ UHTTP_THREADS: '1' })

    const heapOf = async (port: number): Promise<number> =>
      Number((await (await openConnection(port)).exchange(requestHead('GET', '/heap'))).body.toString())

    expect(await heapOf(limited.port)).toBeLessThan(await heapOf(unlimited.port))
    expect(await heapOf(limited.port)).toBeLessThan(256 * 1024 * 1024)
  })
})

describe('pub/sub across worker threads', () => {
  it('delivers a publish to the subscribers on every worker, and forwards it only to workers with subscribers', async () => {
    const host = await startHost({ UHTTP_THREADS: '3' })
    const sockets = await Promise.all([0, 1, 2].map(() => openSocket(host.port, '/chat/room')))
    const threads = await Promise.all(sockets.map(socket => socket.nextMessage()))
    expect(new Set(threads).size).toBe(3)
    const [alice, bob, carol] = sockets
    if (alice === undefined || bob === undefined || carol === undefined) throw new Error('A socket failed to open.')

    alice.send('hello across threads')

    expect(await bob.nextMessage()).toBe('hello across threads')
    expect(await carol.nextMessage()).toBe('hello across threads')
    expect(await alice.silence(100)).toEqual([])

    bob.close()
    carol.close()
    await Promise.all([bob.closed, carol.closed])
    await pause(100)
    const aliceThread = String(threads[0]).replace('thread ', '')
    const forwards: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const connection = await openConnection(host.port)
      if ((await threadOf(connection)) === aliceThread) continue
      const response = await connection.exchange(requestHead('POST', '/publish/room'))
      forwards.push(Number(response.body.toString()))
    }

    expect(forwards.length).toBeGreaterThan(0)
    expect(forwards.every(count => count === 1)).toBe(true)
    expect(
      (await alice.nextMessages(forwards.length)).every(message => String(message).startsWith('from thread')),
    ).toBe(true)
    expect(host.output()).not.toContain('corked callback')
  })

  it('stops forwarding a publish to a worker that crashed', async () => {
    const host = await startHost({ UHTTP_THREADS: '2', UHTTP_CRASH_LIMIT: '10' })
    const listener = await openSocket(host.port, '/chat/news')
    const listenerThread = String(await listener.nextMessage()).replace('thread ', '')
    const [other] = [...(await threadsSeen(host.port, 4))].filter(thread => thread !== listenerThread)

    await (await connectionTo(host.port, listenerThread)).exchange(requestHead('GET', '/crash'))
    expect((await listener.closed).code).toBe(1006)
    const publisher = await connectionTo(host.port, other ?? '')
    const response = await publisher.exchange(requestHead('POST', '/publish/news'))

    expect(response.body.toString()).toBe('0')
  })
})
