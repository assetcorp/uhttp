import { describe, expect, it } from 'vitest'
import { type App, createApp } from '../../index.js'
import { rawRequest, requestHead } from '../helpers/raw-http.js'
import { memoryLogger, start } from '../helpers/server.js'

const ROUTES: readonly (readonly [method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options', path: string])[] = [
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
]

const PARAMETER_VALUES = ['42', 'me', 'b', 'about', 'index', 'a%2Fb', '%E0%A4%A', '']
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get', 'PROPFIND']
const BATCH_SIZE = 40

function buildApp(logger: ReturnType<typeof memoryLogger>['logger']): App {
  const app = createApp({ logger })
  for (const [method, path] of ROUTES) {
    app[method](path, c => c.json({ route: `${method} ${path}`, params: c.req.params() }))
  }
  return app
}

function samplePaths(): string[] {
  const paths = new Set<string>(['/', '//', '/missing', '/Users', '/USERS/me', '/caf%c3%a9', '/café'])
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

async function overNetwork(port: number, method: string, path: string): Promise<Observed> {
  const response = await rawRequest(port, requestHead(method, path), { bodyless: method === 'HEAD' })
  return {
    status: response.status,
    allow: response.headers.get('allow')?.join(', ') ?? null,
    body: response.body.toString(),
  }
}

async function throughMatcher(app: App, method: string, path: string): Promise<Observed> {
  const response = await app.request(path, { method })
  return { status: response.status, allow: response.headers.get('allow'), body: await response.text() }
}

describe('the native router and the JavaScript matcher', () => {
  it('give the same status, Allow header, and body for every sample path and method', async () => {
    const { entries, logger } = memoryLogger()
    const app = buildApp(logger)
    const server = await start(app)
    const cases = samplePaths().flatMap(path => METHODS.map(method => ({ method, path })))
    const disagreements: string[] = []

    for (let index = 0; index < cases.length; index += BATCH_SIZE) {
      await Promise.all(
        cases.slice(index, index + BATCH_SIZE).map(async ({ method, path }) => {
          const [native, matcher] = await Promise.all([
            overNetwork(server.port, method, path),
            throughMatcher(app, method, path),
          ])
          if (JSON.stringify(native) !== JSON.stringify(matcher)) {
            disagreements.push(
              `${method} ${path}: native ${JSON.stringify(native)}, matcher ${JSON.stringify(matcher)}`,
            )
          }
        }),
      )
    }

    expect(cases.length).toBeGreaterThan(1_000)
    expect(disagreements).toEqual([])
    expect(entries.filter(entry => entry.level === 'warn')).toEqual([])
  })
})
