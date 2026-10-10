import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Extractor, ExtractorConfig, type ExtractorMessage } from '@microsoft/api-extractor'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPORT_DIR = join(PACKAGE_DIR, 'etc')
const DIST_DIR = join(PACKAGE_DIR, 'dist')
const EXPORTED_DECLARATION =
  /^\s*export (?:declare )?(?:default )?(?:abstract )?(?:class|function|const|let|var|interface|type|enum|namespace) /
const WORK_DIR = join(PACKAGE_DIR, '.cache', 'api-extractor')
const CONFIG_DIR = join(WORK_DIR, 'config')
const GENERATED_DIR = join(WORK_DIR, 'reports')
const TEMP_DIR = join(WORK_DIR, 'temp')
const REPORT_SUFFIX = '.api.md'
const WRITE_HINT = `Run 'pnpm nx run uhttp:api:write' to regenerate every API report, and commit the change.`
const QUOTED_NAME = /"([^"]+)"/g

interface EntryPoint {
  subpath: string
  reportName: string
  typesPath: string
}

function readExports(): { name: string; exports: Record<string, unknown> } {
  const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null) throw new Error('package.json contains no object.')
  const name: unknown = Reflect.get(manifest, 'name')
  const exports: unknown = Reflect.get(manifest, 'exports')
  if (typeof name !== 'string') throw new Error('package.json has no name field.')
  if (typeof exports !== 'object' || exports === null) throw new Error('package.json has no exports map.')
  return { name, exports: { ...exports } }
}

function typesTarget(condition: unknown): string | undefined {
  if (typeof condition !== 'object' || condition === null) return undefined
  const types: unknown = Reflect.get(condition, 'types')
  if (typeof types === 'string') return types
  for (const nested of Object.values(condition)) {
    const found = typesTarget(nested)
    if (found !== undefined) return found
  }
  return undefined
}

function entryPoints(): EntryPoint[] {
  const { name, exports } = readExports()
  const found: EntryPoint[] = []
  for (const [subpath, condition] of Object.entries(exports)) {
    const types = typesTarget(condition)
    if (types === undefined) throw new Error(`package.json lists no types condition for the '${subpath}' export.`)
    const reportName =
      subpath === '.' ? name.replace(/^@[^/]+\//, '') : subpath.replace(/^\.\//, '').replaceAll('/', '-')
    found.push({ subpath, reportName, typesPath: join(PACKAGE_DIR, types) })
  }
  return found.sort((left, right) => left.reportName.localeCompare(right.reportName))
}

function writeConfig(entry: EntryPoint): string {
  const path = join(CONFIG_DIR, `${entry.reportName}.json`)
  const config = {
    projectFolder: PACKAGE_DIR,
    mainEntryPointFilePath: entry.typesPath,
    newlineKind: 'lf',
    apiReport: {
      enabled: true,
      reportFolder: GENERATED_DIR,
      reportTempFolder: TEMP_DIR,
      reportFileName: `${entry.reportName}${REPORT_SUFFIX}`,
    },
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    compiler: {
      overrideTsconfig: {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2023'],
          strict: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['dist/**/*.d.ts'],
      },
    },
    messages: {
      compilerMessageReporting: { default: { logLevel: 'error' } },
      extractorMessageReporting: {
        default: { logLevel: 'error' },
        'ae-missing-release-tag': { logLevel: 'none' },
        'ae-internal-missing-underscore': { logLevel: 'none' },
        'ae-undocumented': { logLevel: 'error', addToApiReportFile: false },
        'ae-forgotten-export': { logLevel: 'error', addToApiReportFile: false },
      },
      tsdocMessageReporting: { default: { logLevel: 'error' } },
    },
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return path
}

function itemName(message: ExtractorMessage): string {
  const quoted = [...message.text.matchAll(QUOTED_NAME)]
  return quoted.at(-1)?.[1] ?? message.text
}

function analyse(entry: EntryPoint): string[] {
  const problems: string[] = []
  const config = ExtractorConfig.loadFileAndPrepare(writeConfig(entry))
  Extractor.invoke(config, {
    localBuild: true,
    showVerboseMessages: false,
    messageCallback(message: ExtractorMessage): void {
      message.handled = true
      if (message.category === 'console' || message.logLevel === 'none') return
      if (message.messageId === 'ae-undocumented') {
        problems.push(`${entry.subpath}: ${itemName(message)} has no TSDoc comment.`)
        return
      }
      if (message.messageId === 'ae-forgotten-export') {
        problems.push(`${entry.subpath}: ${itemName(message)} appears in the published types, so export it.`)
        return
      }
      const location = message.sourceFilePath === undefined ? '' : ` (${message.sourceFilePath})`
      problems.push(`${entry.subpath}: ${message.text}${location}`)
    },
  })
  return problems
}

function reconcile(entries: EntryPoint[], write: boolean): string[] {
  const problems: string[] = []
  const expected = new Set(entries.map(entry => `${entry.reportName}${REPORT_SUFFIX}`))
  for (const entry of entries) {
    const file = `${entry.reportName}${REPORT_SUFFIX}`
    const generatedPath = join(GENERATED_DIR, file)
    if (!existsSync(generatedPath)) {
      problems.push(`API Extractor wrote no report for the '${entry.subpath}' export.`)
      continue
    }
    const generated = readFileSync(generatedPath, 'utf8')
    const committedPath = join(REPORT_DIR, file)
    if (write) {
      writeFileSync(committedPath, generated)
      continue
    }
    if (!existsSync(committedPath)) {
      problems.push(`The '${entry.subpath}' export has no API report at etc/${file}.`)
      continue
    }
    if (readFileSync(committedPath, 'utf8') !== generated) {
      problems.push(`The '${entry.subpath}' export changed, but etc/${file} contains the old API.`)
    }
  }
  for (const file of readdirSync(REPORT_DIR).filter(name => name.endsWith(REPORT_SUFFIX))) {
    if (expected.has(file)) continue
    if (write) {
      rmSync(join(REPORT_DIR, file))
      continue
    }
    problems.push(`etc/${file} matches no export in package.json.`)
  }
  return problems
}

function declarationFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return declarationFiles(path)
    return entry.name.endsWith('.d.ts') ? [path] : []
  })
}

function undocumentedDeclarations(): string[] {
  const problems: string[] = []
  for (const path of declarationFiles(DIST_DIR)) {
    const lines = readFileSync(path, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (!EXPORTED_DECLARATION.test(line)) return
      const previous = lines
        .slice(0, index)
        .findLast(candidate => candidate.trim() !== '')
        ?.trim()
      if (previous?.endsWith('*/')) return
      problems.push(`${relative(PACKAGE_DIR, path)}:${index + 1}: '${line.trim()}' has no TSDoc comment.`)
    })
  }
  return problems
}

function run(write: boolean): number {
  rmSync(WORK_DIR, { recursive: true, force: true })
  for (const directory of [CONFIG_DIR, GENERATED_DIR, TEMP_DIR, REPORT_DIR]) {
    mkdirSync(directory, { recursive: true })
  }
  const entries = entryPoints()
  const missing = entries.filter(entry => !existsSync(entry.typesPath))
  if (missing.length > 0) {
    for (const entry of missing)
      console.error(`The '${entry.subpath}' export has no built types at ${entry.typesPath}.`)
    console.error(`Run 'pnpm nx run uhttp:build' first.`)
    return 1
  }
  const problems = undocumentedDeclarations()
  problems.push(...entries.flatMap(analyse))
  problems.push(...reconcile(entries, write))
  if (problems.length === 0) {
    console.log(`Every published declaration has TSDoc, and the API reports in etc/ match the exports.`)
    return 0
  }
  for (const problem of problems) console.error(problem)
  if (!write) console.error(`\n${WRITE_HINT}`)
  return 1
}

process.exitCode = run(process.argv.includes('--write'))
