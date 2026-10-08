import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const DAY_MS = 24 * 60 * 60 * 1000
const LOCKFILE = 'pnpm-lock.yaml'
const REGISTRY_URL = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 10_000
const LOCKFILE_MAX_BUFFER_BYTES = 64 * 1024 * 1024

const ALLOWED_URL_DEPENDENCIES = new Set(['uWebSockets.js'])

const AGE_EXEMPT_PACKAGES = new Set()

const isUrlSourcedVersion = version => /^(https?:|git:|git\+|github:)/.test(version)

const parsePositiveInteger = value => {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error('MIN_AGE_DAYS must be a positive integer.')
  }

  return parsed
}

const minAgeDays = parsePositiveInteger(process.env.MIN_AGE_DAYS || '4')
const minimumPublishedAt = Date.now() - minAgeDays * DAY_MS

const readBaseShaFromEvent = () => {
  const eventPath = process.env.GITHUB_EVENT_PATH

  if (!eventPath || !existsSync(eventPath)) {
    return undefined
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'))

  return event.pull_request?.base?.sha
}

const gitCommitExists = ref => {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const resolveBaseRef = () => {
  const candidates = [
    process.env.BASE_SHA,
    readBaseShaFromEvent(),
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    'origin/main',
    'HEAD~1',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (gitCommitExists(candidate)) {
      return candidate
    }
  }

  throw new Error('Could not resolve a base commit to compare pnpm-lock.yaml against.')
}

const readBaseLockfile = baseRef => {
  try {
    return execFileSync('git', ['show', `${baseRef}:${LOCKFILE}`], {
      encoding: 'utf8',
      maxBuffer: LOCKFILE_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

const parsePnpmPackageKey = key => {
  const packageKey = key.split('(')[0]
  const versionSeparator = packageKey.lastIndexOf('@')

  if (versionSeparator <= 0) {
    return undefined
  }

  const name = packageKey.slice(0, versionSeparator)
  const version = packageKey.slice(versionSeparator + 1)

  if (!name || !version || version.startsWith('link:') || version.startsWith('workspace:')) {
    return undefined
  }

  return { name, version }
}

const createPackageKey = pkg => `${pkg.name}@${pkg.version}`

const parsePnpmLock = content => {
  const packages = new Map()
  let inPackages = false

  for (const line of content.split(/\r?\n/)) {
    if (line === 'packages:') {
      inPackages = true
      continue
    }

    if (inPackages && /^[a-zA-Z][^:]*:\s*$/.test(line)) {
      break
    }

    if (!inPackages) {
      continue
    }

    const match = line.match(/^ {2}(['"]?)([^'"]+)\1:\s*$/)

    if (!match) {
      continue
    }

    const pkg = parsePnpmPackageKey(match[2])

    if (pkg) {
      packages.set(createPackageKey(pkg), pkg)
    }
  }

  return packages
}

const fetchMetadata = async (name, cache) => {
  if (cache.has(name)) {
    return cache.get(name)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(`${REGISTRY_URL}/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status} for ${name}`)
    }

    const metadata = await response.json()
    cache.set(name, metadata)

    return metadata
  } finally {
    clearTimeout(timeout)
  }
}

const formatError = error => (error instanceof Error ? error.message : String(error))

const comparePackages = (left, right) => createPackageKey(left).localeCompare(createPackageKey(right))

const escapeAnnotationValue = value => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

const main = async () => {
  const baseRef = resolveBaseRef()
  const currentPackages = parsePnpmLock(readFileSync(LOCKFILE, 'utf8'))
  const basePackages = parsePnpmLock(readBaseLockfile(baseRef))
  const addedPackages = [...currentPackages.values()]
    .filter(pkg => !basePackages.has(createPackageKey(pkg)))
    .sort(comparePackages)

  if (addedPackages.length === 0) {
    console.log('Dependency age gate passed. No new pnpm package versions were added.')
    return
  }

  console.log(`Checking ${addedPackages.length} newly added pnpm package version(s).`)

  const failures = []
  const metadataByName = new Map()

  for (const pkg of addedPackages) {
    const packageKey = createPackageKey(pkg)

    if (AGE_EXEMPT_PACKAGES.has(pkg.name)) {
      console.log(`Skipping ${packageKey}: first-party package exempt from the age gate.`)
      continue
    }

    if (ALLOWED_URL_DEPENDENCIES.has(pkg.name) && isUrlSourcedVersion(pkg.version)) {
      console.log(`Skipping ${packageKey}: pinned URL dependency, verified by the supply-chain gate.`)
      continue
    }

    let metadata

    try {
      metadata = await fetchMetadata(pkg.name, metadataByName)
    } catch (error) {
      failures.push(`${packageKey}: npm metadata lookup failed: ${formatError(error)}`)
      continue
    }

    const publishedAt = metadata.time?.[pkg.version]

    if (typeof publishedAt !== 'string') {
      failures.push(`${packageKey}: publish timestamp was not available from the npm registry`)
      continue
    }

    const publishedTime = Date.parse(publishedAt)

    if (Number.isNaN(publishedTime)) {
      failures.push(`${packageKey}: publish timestamp is invalid: ${publishedAt}`)
      continue
    }

    if (publishedTime > minimumPublishedAt) {
      const ageDays = Math.max(0, (Date.now() - publishedTime) / DAY_MS).toFixed(2)
      failures.push(`${packageKey}: published ${ageDays} day(s) ago, below the ${minAgeDays} day minimum`)
    }
  }

  if (failures.length === 0) {
    console.log(`Dependency age gate passed. All new package versions are at least ${minAgeDays} day(s) old.`)
    return
  }

  console.error(`Dependency age gate failed. ${failures.length} package version(s) are too new or unverifiable.`)

  for (const failure of failures) {
    console.error(`- ${failure}`)
    console.error(`::error title=Dependency age gate failed::${escapeAnnotationValue(failure)}`)
  }

  process.exitCode = 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
