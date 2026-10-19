import { describe, expect, it } from 'vitest'
import { type App, createApp } from '../../index.js'
import { openConnection, requestHead } from '../helpers/http-client.js'
import { memoryLogger, start } from '../helpers/server.js'
import { bodyOf, handshakeHeaders, rawHandshake, upgradeHead } from '../helpers/websocket.js'

type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'ws'

const ROUTES: readonly (readonly [method: RouteMethod, path: string])[] = [
  ['ws', '/live'],
  ['ws', '/live/:room'],
  ['ws', '/users/:id/socket'],
  ['ws', '/admin'],
  ['ws', '/pages/:slug/edit'],
  ['get', '/'],
  ['get', '/users'],
  ['get', '/users/'],
  ['get', '/users/:id'],
  ['get', '/users/me'],
  ['post', '/users/:id'],
  ['delete', '/users/me'],
  ['get', '/users/:id/posts/:post'],
  ['get', '/files/:folder/index'],
  ['get', '/files/b/:name'],
  ['get', '/pages/about/team'],
  ['get', '/pages/:slug/edit'],
  ['put', '/a/:b/:c/d'],
  ['patch', '/x//y'],
  ['options', '/opts'],
  ['get', '/caf%C3%A9'],
  ['get', '/api/v1/:resource'],
  ['get', '/admin'],
]

const PARAMETER_VALUES = ['42', 'me', 'b', 'about', 'index', 'a%2Fb', '%E0%A4%A', '', '..', '%2e%2e', '.']
const TRAVERSAL_PATHS = [
  '/users/../admin',
  '/users/%2e%2e/admin',
  '/./admin',
  '/admin/.',
  '/admin/',
  '//admin',
  '/%61dmin',
  '/ADMIN',
  '/admin%2f',
  '/admin;x',
  '/admin?x=1',
  '/users/me/../../admin',
]
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get', 'PROPFIND']
const CONNECTION_COUNT = 40

function buildApp(logger: ReturnType<typeof memoryLogger>['logger']): App {
  const app = createApp({ logger })
  for (const [method, path] of ROUTES) {
    if (method === 'ws') {
      app.ws(path, {
        open: socket => {
          socket.end()
        },
      })
      continue
    }
    app[method](path, c => c.json({ route: `${method} ${path}`, params: c.req.params() }))
  }
  return app
}

const UPGRADE_VARIANTS: readonly Record<string, string>[] = [
  {},
  { origin: 'null' },
  { origin: 'http://127.0.0.1' },
  { 'sec-websocket-version': '8' },
  { upgrade: 'h2c' },
]

function samplePaths(): string[] {
  const paths = new Set<string>([
    '/',
    '//',
    '/missing',
    '/Users',
    '/USERS/me',
    '/caf%c3%a9',
    '/café',
    ...TRAVERSAL_PATHS,
  ])
  for (const [, path] of ROUTES) {
    for (const value of PARAMETER_VALUES) {
      const filled = path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, value)
      paths.add(filled)
      paths.add(filled.endsWith('/') ? filled.slice(0, -1) || '/' : `${filled}/`)
      paths.add(`${filled}/extra`)
      paths.add(`/${filled}`)
      paths.add(filled.toUpperCase())
    }
  }
  return [...paths].filter(path => path.startsWith('/') && !/[\s]/.test(path))
}

interface Observed {
  status: number
  allow: string | null
  body: string
}

interface Case {
  method: string
  path: string
}

async function throughMatcher(app: App, { method, path }: Case): Promise<Observed> {
  const response = await app.request(path, { method })
  return { status: response.status, allow: response.headers.get('allow'), body: await response.text() }
}

async function overOneConnection(port: number, cases: Case[]): Promise<Map<Case, Observed>> {
  const observed = new Map<Case, Observed>()
  const connection = await openConnection(port)
  for (const sample of cases) {
    const response = await connection.exchange(requestHead(sample.method, sample.path), { method: sample.method })
    observed.set(sample, {
      status: response.status,
      allow: response.headers.get('allow')?.join(', ') ?? null,
      body: response.body.toString(),
    })
  }
  expect(connection.state).toBe('open')
  return observed
}

describe('the native router and the JavaScript matcher', () => {
  it('give the same status, Allow header, and body for every sample path and method, over connections that stay open', async () => {
    const { entries, logger } = memoryLogger()
    const app = buildApp(logger)
    const server = await start(app)
    const cases = samplePaths().flatMap(path => METHODS.map(method => ({ method, path })))
    const shares = Array.from({ length: CONNECTION_COUNT }, (_, index) =>
      cases.filter((_case, position) => position % CONNECTION_COUNT === index),
    )

    const observed = await Promise.all(shares.map(share => overOneConnection(server.port, share)))
    const disagreements: string[] = []
    for (const results of observed) {
      for (const [sample, native] of results) {
        const matcher = await throughMatcher(app, sample)
        if (JSON.stringify(native) !== JSON.stringify(matcher)) {
          disagreements.push(
            `${sample.method} ${sample.path}: native ${JSON.stringify(native)}, matcher ${JSON.stringify(matcher)}`,
          )
        }
      }
    }

    expect(cases.length).toBeGreaterThan(1_000)
    expect(disagreements).toEqual([])
    expect(entries.filter(entry => entry.level === 'warn')).toEqual([])
  })

  it('give the same status and body for an upgrade request to every sample path, each over a new connection', async () => {
    const { entries, logger } = memoryLogger()
    const app = buildApp(logger)
    const server = await start(app)
    const paths = samplePaths().filter((_path, index) => index % 3 === 0)
    const cases = paths.flatMap(path => UPGRADE_VARIANTS.map(variant => ({ path, variant })))

    const disagreements: string[] = []
    let upgrades = 0
    for (let index = 0; index < cases.length; index += CONNECTION_COUNT) {
      const batch = cases.slice(index, index + CONNECTION_COUNT)
      const results = await Promise.all(
        batch.map(async ({ path, variant }) => {
          const headers = handshakeHeaders({ host: `127.0.0.1:${server.port}`, ...variant })
          const native = await rawHandshake(server.port, upgradeHead(path, headers))
          const matcher = await app.request(path, { headers })
          const nativeBody = native.status === 101 ? '' : await bodyOf(native)
          native.socket.destroy()
          return { path, variant, native: [native.status, nativeBody], matcher: [matcher.status, await matcher.text()] }
        }),
      )
      for (const result of results) {
        if (result.native[0] === 101) upgrades++
        if (JSON.stringify(result.native) !== JSON.stringify(result.matcher)) {
          disagreements.push(
            `${result.path} ${JSON.stringify(result.variant)}: native ${JSON.stringify(result.native)}, matcher ${JSON.stringify(result.matcher)}`,
          )
        }
      }
    }

    expect(upgrades).toBeGreaterThan(5)
    expect(disagreements).toEqual([])
    expect(entries.filter(entry => entry.level === 'warn')).toEqual([])
  })

  it('reaches the /admin route only through its exact path, whatever dot segments or encodings the client sends', async () => {
    const reached: string[] = []
    const app = createApp()
      .get('/admin', c => {
        reached.push(`${c.req.path}?${c.req.query}`)
        return c.text('admin')
      })
      .get('/users/:id', c => c.text(`user ${c.req.params().id}`))
    const server = await start(app)
    const connection = await openConnection(server.port)

    for (const path of ['/admin', ...TRAVERSAL_PATHS]) await connection.exchange(requestHead('GET', path))

    expect(reached).toEqual(['/admin?', '/admin?x=1'])
    expect(await connection.waitForClose(200)).toBe('open')
  })
})
