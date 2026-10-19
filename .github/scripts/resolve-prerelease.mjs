import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const NX_CONFIG = 'nx.json'
const PACKAGE_MANIFEST = 'packages/ts/package.json'
const MAIN_BRANCH_REF = 'refs/heads/main'
const REGISTRY_URL = 'https://registry.npmjs.org'
const PRERELEASE_IDENTIFIER = 'next'
const REGISTRY_TIMEOUT_MS = 15_000

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const remoteRefs = args =>
  execFileSync('git', ['ls-remote', ...args, 'origin'], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const [sha, ref] = line.split('\t')
      return { sha, ref }
    })

const releaseTagMatcher = pattern => {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error(`${NX_CONFIG} must define release.releaseTag.pattern`)
  }

  const expanded = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{projectName\\\}/g, '\\S+')
    .replace(/\\\{releaseGroupName\\\}/g, '\\S+')
    .replace(/\\\{version\\\}/g, '\\d+\\.\\d+\\.\\d+[0-9A-Za-z.+-]*')

  const unsupported = expanded.match(/\\\{[^}]*\\\}/)
  if (unsupported !== null) {
    throw new Error(`release.releaseTag.pattern uses a placeholder that this script cannot expand: ${unsupported[0]}`)
  }

  return new RegExp(`^${expanded}$`)
}

const releaseTagsOn = commit => {
  const matcher = releaseTagMatcher(readJson(NX_CONFIG).release?.releaseTag?.pattern)
  const tags = []

  for (const { sha, ref } of remoteRefs(['--tags'])) {
    if (sha !== commit || ref === undefined) continue
    const tag = ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')
    if (matcher.test(tag)) tags.push(tag)
  }

  return tags
}

const mainTip = () => remoteRefs(['--heads']).find(({ ref }) => ref === MAIN_BRANCH_REF)?.sha

const releaseParts = version => {
  const parts = String(version).split(/[-+]/)[0].split('.').map(Number)
  if (parts.length !== 3 || parts.some(part => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error(`The script cannot read a major.minor.patch version from "${version}"`)
  }
  return parts
}

const higherRelease = (left, right) => {
  const leftParts = releaseParts(left)
  const rightParts = releaseParts(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? leftParts : rightParts
  }
  return leftParts
}

const publishedLatest = async packageName => {
  const response = await fetch(`${REGISTRY_URL}/${packageName.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`The npm registry answered ${response.status} for ${packageName}`)
  const latest = (await response.json())['dist-tags']?.latest
  if (typeof latest !== 'string') throw new Error(`The npm registry lists no latest version of ${packageName}`)
  return latest
}

const writeOutput = (key, value) => {
  const target = process.env.GITHUB_OUTPUT
  if (target === undefined) {
    console.log(`${key}=${value}`)
    return
  }
  appendFileSync(target, `${key}=${value}\n`)
}

const skip = reason => {
  console.log(reason)
  writeOutput('publish', 'false')
}

const main = async () => {
  const commit = process.env.GITHUB_SHA
  const runNumber = process.env.GITHUB_RUN_NUMBER
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT
  if (commit === undefined || runNumber === undefined || runAttempt === undefined) {
    throw new Error(
      'The script reads GITHUB_SHA, GITHUB_RUN_NUMBER, and GITHUB_RUN_ATTEMPT, which GitHub Actions sets, and one of them is missing.',
    )
  }

  const tip = mainTip()
  if (tip !== commit) {
    skip(`The workflow publishes no prerelease for ${commit}, because main points at ${tip ?? 'an unknown commit'}.`)
    return
  }

  const releaseTags = releaseTagsOn(commit)
  if (releaseTags.length > 0) {
    skip(`${commit} already has the release tag ${releaseTags[0]}, so the workflow publishes no prerelease for it.`)
    return
  }

  const manifest = readJson(PACKAGE_MANIFEST)
  const latest = await publishedLatest(manifest.name)
  if (latest === undefined) {
    skip(`${manifest.name} is not on npm yet, so the maintainer has to publish its first version by hand.`)
    return
  }

  const [major, minor, patch] = higherRelease(manifest.version, latest)
  const version = `${major}.${minor}.${patch + 1}-${PRERELEASE_IDENTIFIER}.${runNumber}.${runAttempt}`
  console.log(`The workflow publishes ${version} under the ${PRERELEASE_IDENTIFIER} dist-tag.`)
  writeOutput('publish', 'true')
  writeOutput('version', version)
}

await main()
