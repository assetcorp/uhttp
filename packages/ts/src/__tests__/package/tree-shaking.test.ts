import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { rollup } from 'rollup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_DIR = resolve(import.meta.dirname, '../../..')
const OUT_DIR = join(PACKAGE_DIR, '.cache', 'tree-shaking-test', 'dist')
const TSC = join(PACKAGE_DIR, 'node_modules', '.bin', 'tsc')
const PACKAGE_NAME = '@delali/uhttp'
const ENTRY_ID = '\0entry'

const MIDDLEWARE: readonly (readonly [subpath: string, exported: string, usage: string])[] = [
  ['trusted-proxies', 'trustedProxies', "trustedProxies({ trust: ['10.0.0.1'] })"],
  ['request-id', 'requestId', 'requestId()'],
  ['access-log', 'accessLog', 'accessLog()'],
  ['rate-limit', 'rateLimit', 'rateLimit({ limit: 10, windowMs: 1000 })'],
  ['secure-headers', 'secureHeaders', 'secureHeaders()'],
  ['cors', 'cors', "cors({ origin: '*' })"],
  ['csrf', 'csrf', 'csrf()'],
  ['cookies', 'cookies', 'cookies()'],
  ['compression', 'compression', 'compression()'],
  ['static', 'serveStatic', "serveStatic({ root: '.' })"],
]

function exportTarget(subpath: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  const exports: unknown =
    typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'exports') : undefined
  const entry: unknown = typeof exports === 'object' && exports !== null ? Reflect.get(exports, subpath) : undefined
  const target: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'import') : undefined
  if (typeof target !== 'string') throw new Error(`package.json has no import target for '${subpath}'.`)
  return join(OUT_DIR, target.replace(/^\.\/dist\//, ''))
}

async function bundle(source: string): Promise<string> {
  const build = await rollup({
    input: ENTRY_ID,
    external: id => id.startsWith('node:') || id === 'uWebSockets.js',
    treeshake: { moduleSideEffects: id => !id.startsWith(OUT_DIR) },
    onwarn: () => undefined,
    plugins: [
      {
        name: 'package-exports',
        resolveId(id) {
          if (id === ENTRY_ID) return id
          if (id === PACKAGE_NAME) return exportTarget('.')
          if (id.startsWith(`${PACKAGE_NAME}/`)) return exportTarget(`./${id.slice(PACKAGE_NAME.length + 1)}`)
          return null
        },
        load(id) {
          return id === ENTRY_ID ? source : null
        },
      },
    ],
  })
  const { output } = await build.generate({ format: 'es' })
  await build.close()
  return output.map(chunk => (chunk.type === 'chunk' ? chunk.code : '')).join('\n')
}

function definesFunction(code: string, name: string): boolean {
  return new RegExp(`function ${name}\\(`).test(code)
}

beforeAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true })
  execFileSync(TSC, ['-p', 'tsconfig.build.json', '--outDir', OUT_DIR], { cwd: PACKAGE_DIR })
})

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true })
})

describe('a bundler', () => {
  it('drops every middleware from an app that imports none', async () => {
    const code = await bundle(
      `import { createApp } from '${PACKAGE_NAME}'\nexport default createApp().get('/', c => c.text('home'))`,
    )

    expect(definesFunction(code, 'createApp')).toBe(true)
    for (const [, exported] of MIDDLEWARE) expect(definesFunction(code, exported), exported).toBe(false)
  })

  it.each(MIDDLEWARE)('keeps %s alone from an app that imports it alone', async (subpath, exported, usage) => {
    const code = await bundle(
      [
        `import { createApp } from '${PACKAGE_NAME}'`,
        `import { ${exported} } from '${PACKAGE_NAME}/${subpath}'`,
        `export default createApp().use(${usage})`,
      ].join('\n'),
    )

    expect(definesFunction(code, exported)).toBe(true)
    for (const [, other] of MIDDLEWARE) {
      if (other !== exported) expect(definesFunction(code, other), other).toBe(false)
    }
  })
})
