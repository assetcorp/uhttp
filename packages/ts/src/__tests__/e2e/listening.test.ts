import { lstatSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp, serve } from '../../index.js'
import { track } from '../helpers/server.js'

const HOST = '127.0.0.1'
const PERMISSION_BITS = 0o777

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function socketPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'uhttp-unix-')), 'server.sock')
}

function named(text: string) {
  return createApp().get('/name', c => c.text(text))
}

describe('a server on a port', () => {
  it('reports the port that the operating system chose for port 0', async () => {
    const server = track(await serve({ app: named('chosen'), port: 0, host: HOST }))

    expect(server.port).toBeGreaterThan(0)
    expect(await (await fetch(`http://${HOST}:${server.port}/name`)).text()).toBe('chosen')
  })

  it('binds its port exclusively, so that a second server on the same port fails with LISTEN_FAILED', async () => {
    const port = await freePort()
    const first = track(await serve({ app: named('first'), port, host: HOST }))

    await expect(serve({ app: named('second'), port, host: HOST })).rejects.toMatchObject({ code: 'LISTEN_FAILED' })
    await expect(serve({ app: named('second'), port, host: HOST, reusePort: true })).rejects.toMatchObject({
      code: 'LISTEN_FAILED',
    })
    expect(await (await fetch(`http://${HOST}:${first.port}/name`)).text()).toBe('first')
  })

  it('shares a port between two servers that both set reusePort', async () => {
    const port = await freePort()
    track(await serve({ app: named('first'), port, host: HOST, reusePort: true }))
    track(await serve({ app: named('second'), port, host: HOST, reusePort: true }))

    const response = await fetch(`http://${HOST}:${port}/name`)

    expect(['first', 'second']).toContain(await response.text())
    await expect(serve({ app: named('third'), port, host: HOST })).rejects.toMatchObject({ code: 'LISTEN_FAILED' })
  })

  it('binds every interface exclusively when the host is left out', async () => {
    const port = await freePort()
    track(await serve({ app: named('first'), port }))

    await expect(serve({ app: named('second'), port })).rejects.toMatchObject({ code: 'LISTEN_FAILED' })
  })
})

describe('a server on a Unix socket', () => {
  it('sets the mode of the socket file to 0o600 once it listens', async () => {
    const path = socketPath()
    const server = await serve({ app: named('unix'), path })

    expect(lstatSync(path).mode & PERMISSION_BITS).toBe(0o600)
    await server.close()
  })

  it('sets the mode from socketMode once it listens', async () => {
    const path = socketPath()
    const server = await serve({ app: named('unix'), path, socketMode: 0o660 })

    expect(lstatSync(path).mode & PERMISSION_BITS).toBe(0o660)
    await server.close()
  })
})

describe('the listening options of serve()', () => {
  it('throws INVALID_SERVE_OPTIONS for a listening option of the wrong type, outside its range, or with the wrong address', async () => {
    const app = createApp()
    const invalid: unknown[] = [
      { app, port: 3000, reusePort: 'yes' },
      { app, port: 0, reusePort: true },
      { app, path: socketPath(), reusePort: true },
      { app, port: 0, socketMode: 0o600 },
      { app, path: socketPath(), socketMode: -1 },
      { app, path: socketPath(), socketMode: 0o1000 },
      { app, path: socketPath(), socketMode: 1.5 },
      { app, port: 0, gracePeriodMs: -1 },
      { app, port: 0, gracePeriodMs: 2 ** 31 },
      { app, port: 0, gracePeriodMs: '10s' },
    ]

    for (const options of invalid) {
      await expect(Reflect.apply(serve, undefined, [options]), JSON.stringify(options)).rejects.toMatchObject({
        code: 'INVALID_SERVE_OPTIONS',
      })
    }
  })
})
