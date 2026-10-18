import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as Uhttp from '../../index.js'

const PACKAGE_DIR = resolve(import.meta.dirname, '../../..')
const SOURCE_DIR = join(PACKAGE_DIR, 'src')
const OUT_DIR = join(PACKAGE_DIR, '.cache', 'package-test', 'dist')
const TSC = join(PACKAGE_DIR, 'node_modules', '.bin', 'tsc')

function sourceModules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceModules(path)
    return entry.name.endsWith('.ts') ? [relative(SOURCE_DIR, path).slice(0, -'.ts'.length)] : []
  })
}

const MIDDLEWARE_SUBPATHS = [
  'access-log',
  'compression',
  'cookies',
  'cors',
  'csrf',
  'rate-limit',
  'request-id',
  'secure-headers',
  'static',
  'trusted-proxies',
]

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
}

beforeAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true })
  execFileSync(TSC, ['-p', 'tsconfig.build.json', '--outDir', OUT_DIR], { cwd: PACKAGE_DIR })
})

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true })
})

describe('the built package', () => {
  it('contains one JavaScript file and one declaration file for each source module', () => {
    const modules = sourceModules(SOURCE_DIR)

    expect(modules).toContain('index')
    for (const module of modules) {
      expect(existsSync(join(OUT_DIR, `${module}.js`)), `${module}.js`).toBe(true)
      expect(existsSync(join(OUT_DIR, `${module}.d.ts`)), `${module}.d.ts`).toBe(true)
    }
  })

  it('contains ES modules whose declarations include the TSDoc of each export', () => {
    const javascript = readFileSync(join(OUT_DIR, 'index.js'), 'utf8')
    const declarations = readFileSync(join(OUT_DIR, 'app.d.ts'), 'utf8')

    expect(javascript).toMatch(/^export \{/m)
    expect(javascript).not.toMatch(/\brequire\(|module\.exports/)
    expect(declarations).toMatch(/\/\*\*[\s\S]*?\*\/\s*export declare function createApp/)
  })

  it('serves a route over the network from the built files', async () => {
    const { createApp, serve } = (await import(pathToFileURL(join(OUT_DIR, 'index.js')).href)) as typeof Uhttp
    const server = await serve({ app: createApp().get('/hello', c => c.text('built')), port: 0, host: '127.0.0.1' })

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/hello`)
      expect(await response.text()).toBe('built')
    } finally {
      await server.close()
    }
  })

  it('serves a WebSocket route on worker threads that start from the built files', async () => {
    const { serve } = (await import(pathToFileURL(join(OUT_DIR, 'index.js')).href)) as typeof Uhttp
    const module = join(OUT_DIR, 'echo-app.js')
    writeFileSync(
      module,
      [
        "import { threadId } from 'node:worker_threads'",
        "import { createApp } from './index.js'",
        'export default () => createApp()',
        '  .get("/thread", c => c.text(String(threadId)))',
        '  .ws("/echo", { message: (socket, message) => { socket.send(message) } })',
      ].join('\n'),
    )
    const server = await serve({ app: pathToFileURL(module), port: 0, host: '127.0.0.1', threads: 2 })

    try {
      const thread = await (await fetch(`http://127.0.0.1:${server.port}/thread`)).text()
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/echo`)
      const echoed = new Promise<unknown>((resolve, reject) => {
        socket.addEventListener('message', event => resolve(event.data), { once: true })
        socket.addEventListener('error', () => reject(new Error('The WebSocket failed.')), { once: true })
      })
      socket.addEventListener('open', () => socket.send('built echo'), { once: true })

      expect(thread).not.toBe('0')
      expect(await echoed).toBe('built echo')
      socket.close()
    } finally {
      await server.close()
    }
  })
})

describe('the package manifest', () => {
  it('sets the type to module, sets sideEffects to false, and lists a typed entry point for the core and each middleware', () => {
    const manifest = readManifest()
    const middleware = Object.fromEntries(
      MIDDLEWARE_SUBPATHS.map(name => [
        `./${name}`,
        { types: `./dist/middleware/${name}/index.d.ts`, import: `./dist/middleware/${name}/index.js` },
      ]),
    )

    expect(manifest.type).toBe('module')
    expect(manifest.sideEffects).toBe(false)
    expect(manifest.exports).toEqual({ '.': { types: './dist/index.d.ts', import: './dist/index.js' }, ...middleware })
  })

  it('lists no runtime dependencies and a peer range for uWebSockets.js from v20.70.0', () => {
    const manifest = readManifest()

    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.peerDependencies).toEqual({ 'uWebSockets.js': '>=20.70.0 <21' })
    expect(manifest.peerDependenciesMeta).toBeUndefined()
  })

  it('pins the v20.71.0 commit of uWebSockets.js and the Node 22 types for development', () => {
    const devDependencies = readManifest().devDependencies

    expect(devDependencies).toMatchObject({
      'uWebSockets.js': 'github:uNetworking/uWebSockets.js#9ec36de7709996c58dce03d63796216c90a17136',
      '@types/node': expect.stringMatching(/^22\.\d+\.\d+$/),
    })
  })

  it('lists the Node lines for which uWebSockets.js has binaries', () => {
    expect(readManifest().engines).toEqual({ node: '>=22.15 <23 || >=24 <25 || >=26 <27' })
  })
})
