import { readFile } from 'node:fs/promises'
import { arch, cpus, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { TOOL_OUTPUT_TIMEOUT_MS } from './constants.ts'
import { runFile } from './tools.ts'
import type { Pinning, ServerEntry, ServerId, UhttpRevision } from './types.ts'

export interface MachineDetails {
  readonly cpu: { readonly model: string; readonly logical_cores: number }
  readonly memory_bytes: number
  readonly os: { readonly name: string; readonly kernel: string; readonly arch: string }
  readonly tools: Readonly<Record<string, string>>
  readonly pinning: Pinning
}

const SERVER_PACKAGES: Readonly<Record<ServerId, { readonly name: string; readonly packages: readonly string[] }>> = {
  uws: { name: 'uWebSockets.js', packages: ['uWebSockets.js'] },
  uhttp: { name: 'uhttp', packages: ['@delali/uhttp', 'uWebSockets.js'] },
  hono: { name: 'Hono', packages: ['hono', '@hono/node-server'] },
  fastify: { name: 'Fastify', packages: ['fastify', '@fastify/helmet'] },
  express: { name: 'Express', packages: ['express', 'helmet'] },
}

async function output(program: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await runFile(program, args, { timeout: TOOL_OUTPUT_TIMEOUT_MS })
    return stdout.trim()
  } catch {
    return undefined
  }
}

async function packageVersion(suiteDirectory: string, name: string): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(join(suiteDirectory, 'node_modules', name, 'package.json'), 'utf8'),
  )
  const version: unknown =
    typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined
  if (typeof version !== 'string') throw new Error(`The package.json of ${name} has no version.`)
  return version
}

async function operatingSystemName(): Promise<string> {
  if (process.platform === 'darwin') {
    const name = await output('sw_vers', ['-productName'])
    const version = await output('sw_vers', ['-productVersion'])
    return [name ?? 'macOS', version].filter(Boolean).join(' ')
  }
  if (process.platform === 'linux') {
    const text = await readFile('/etc/os-release', 'utf8').catch(() => '')
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(text)?.[1]
    return pretty ?? 'Linux'
  }
  return process.platform
}

export async function uhttpRevision(repositoryRoot: string): Promise<UhttpRevision> {
  const commit = await output('git', ['-C', repositoryRoot, 'rev-parse', '--short=12', 'HEAD'])
  if (commit === undefined) return { uhttp_commit: null, uhttp_uncommitted_changes: false }
  const changes = await output('git', ['-C', repositoryRoot, 'status', '--porcelain', '--', 'packages/ts'])
  return { uhttp_commit: commit, uhttp_uncommitted_changes: changes !== undefined && changes !== '' }
}

export async function serverEntries(suiteDirectory: string, servers: readonly ServerId[]): Promise<ServerEntry[]> {
  const entries: ServerEntry[] = []
  for (const id of servers) {
    const spec = SERVER_PACKAGES[id]
    const packages: Record<string, string> = {}
    for (const name of spec.packages) packages[name] = await packageVersion(suiteDirectory, name)
    entries.push({ id, name: spec.name, packages })
  }
  return entries
}

export async function machineDetails(pinning: Pinning): Promise<MachineDetails> {
  const processors = cpus()
  const h2load = await output('h2load', ['--version'])
  return {
    cpu: { model: processors[0]?.model.trim() ?? 'unknown', logical_cores: processors.length },
    memory_bytes: totalmem(),
    os: { name: await operatingSystemName(), kernel: release(), arch: arch() },
    tools: {
      node: process.version.replace(/^v/, ''),
      h2load: h2load?.replace(/^h2load nghttp2\//, '') ?? 'unknown',
    },
    pinning,
  }
}
