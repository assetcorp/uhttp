import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp, type ServeOptions, serve } from '../../index.js'
import { track } from '../helpers/server.js'

const fixture = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url)

function overUnixSocket(path: string, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath: path, path: target, agent: false }, response => {
      let body = ''
      response.on('data', chunk => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

function socketPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'uhttp-unix-')), 'server.sock')
}

describe('the options of serve()', () => {
  it('throws INVALID_SERVE_OPTIONS for a value outside its range and for options that the package cannot use together', async () => {
    const app = createApp()
    const module = fixture('apps.js')
    const invalid: unknown[] = [
      { app, port: 0, threads: 2 },
      { app: module, path: socketPath(), threads: 2 },
      { app, path: socketPath(), port: 0 },
      { app, path: socketPath(), host: '127.0.0.1' },
      { app, path: '' },
      { app },
      { app: 'not an app', port: 0 },
      { app: module, port: 0, threads: -1 },
      { app: module, port: 0, threads: 1.5 },
      { app: module, port: 0, threads: 1_025 },
      { app, port: 0, workerHeapMb: 64 },
      { app: module, port: 0, threads: 1, workerHeapMb: 0 },
      { app: module, port: 0, threads: 1, crashLimit: 0 },
      { app: module, port: 0, threads: 1, crashWindowMs: 0 },
      { app: module, port: 0, threads: 1, watchdogMs: -1 },
      { app: module, port: 0, threads: 1, watchdogMs: 2 ** 31 },
      { app, port: 0, workerStartTimeoutMs: 1_000 },
      { app: module, port: 0, threads: 1, workerStartTimeoutMs: -1 },
      { app: module, port: 0, threads: 1, workerStartTimeoutMs: 1.5 },
      { app: module, port: 0, threads: 1, workerStartTimeoutMs: 2 ** 31 },
      { app: module, port: 0, threads: 1, workerStartTimeoutMs: '1000' },
      { app, port: 0, logger: { info: () => undefined } },
    ]

    for (const options of invalid) {
      await expect(Reflect.apply(serve, undefined, [options])).rejects.toMatchObject({
        code: 'INVALID_SERVE_OPTIONS',
      })
    }
  })

  it('serves the app that the default export of a module builds, on the main thread', async () => {
    for (const name of ['apps.js', 'async-app.js']) {
      const server = track(await serve({ app: fixture(name), port: 0, host: '127.0.0.1' }))
      const response = await fetch(`http://127.0.0.1:${server.port}/hello`)

      expect(response.status).toBe(200)
      expect(await response.text()).toMatch(/^Hello from/)
      await server.close()
    }
  })

  it('rejects with APP_START_FAILED and the cause when the module throws or exports no app', async () => {
    const failing = serve({ app: fixture('failing-app.js'), port: 0 })
    await expect(failing).rejects.toMatchObject({
      code: 'APP_START_FAILED',
      cause: expect.objectContaining({ code: 'INVALID_APP_OPTIONS' }),
    })
    for (const name of ['not-an-app.js', 'missing-module.js']) {
      await expect(serve({ app: fixture(name), port: 0 } satisfies ServeOptions)).rejects.toMatchObject({
        code: 'APP_START_FAILED',
      })
    }
  })
})

describe('a server on a Unix socket', () => {
  it('serves requests on the socket, reports no port, and removes the socket file once it closes', async () => {
    const path = socketPath()
    const server = await serve({ app: createApp().get('/hello', c => c.text('Hello over a socket')), path })

    expect(server.port).toBeUndefined()
    expect(await overUnixSocket(path, '/hello')).toEqual({ status: 200, body: 'Hello over a socket' })
    await server.close()
    expect(() => lstatSync(path)).toThrowError(expect.objectContaining({ code: 'ENOENT' }))
    await expect(overUnixSocket(path, '/hello')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces a stale socket on which no server answers', async () => {
    const path = socketPath()
    const killed = spawnSync(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`,
    ])
    expect(killed.signal).toBe('SIGKILL')
    expect(lstatSync(path).isSocket()).toBe(true)

    const server = await serve({ app: createApp().get('/hello', c => c.text('fresh')), path })

    expect(await overUnixSocket(path, '/hello')).toEqual({ status: 200, body: 'fresh' })
    await server.close()
  })

  it('refuses a path to a regular file or to a socket with a running server, and leaves both alone', async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'uhttp-unix-')), 'data.txt')
    writeFileSync(filePath, 'keep me')
    const busyPath = socketPath()
    const running = createServer(socket => socket.end())
    await new Promise<void>(resolve => running.listen(busyPath, resolve))

    try {
      await expect(serve({ app: createApp(), path: filePath })).rejects.toMatchObject({ code: 'LISTEN_FAILED' })
      await expect(serve({ app: createApp(), path: busyPath })).rejects.toMatchObject({ code: 'LISTEN_FAILED' })
      expect(readFileSync(filePath, 'utf8')).toBe('keep me')
      expect(lstatSync(busyPath).isSocket()).toBe(true)
    } finally {
      running.close()
    }
  })
})
