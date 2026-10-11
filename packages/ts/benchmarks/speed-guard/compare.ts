import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COMPARE_MEASURED_ROUNDS,
  COMPARE_ROUND_DURATION_MS,
  COMPARE_WARM_UP_ROUNDS,
  CONNECTIONS,
  FLAGGED_CHANGE_FLOOR_RATIO,
  LOAD_CPUS,
  LOAD_THREADS,
  MAX_SLOWDOWN_FROM_BARE_RATIO,
  ROUTE_PATH,
  SERVER_CPU,
} from './constants.ts'
import {
  formatGap,
  formatRate,
  formatShare,
  measure,
  type RunningServer,
  type ServerSpec,
  startServer,
} from './harness.ts'

type Copy = 'bare' | 'main' | 'change' | 'bareCopy' | 'mainCopy' | 'changeCopy'

interface CopySpec {
  copy: Copy
  label: string
  script: string
  entryVariable?: string
}

const BARE_SCRIPT = 'servers/bare.ts'
const UHTTP_SCRIPT = 'servers/uhttp.ts'

const COPIES: readonly CopySpec[] = [
  { copy: 'bare', label: 'uWebSockets.js', script: BARE_SCRIPT },
  { copy: 'main', label: 'main uhttp', script: UHTTP_SCRIPT, entryVariable: 'BASE_ENTRY' },
  { copy: 'change', label: 'PR uhttp', script: UHTTP_SCRIPT, entryVariable: 'CHANGE_ENTRY' },
  { copy: 'bareCopy', label: 'second uWebSockets.js', script: BARE_SCRIPT },
  { copy: 'mainCopy', label: 'second main uhttp', script: UHTTP_SCRIPT, entryVariable: 'BASE_ENTRY' },
  { copy: 'changeCopy', label: 'second PR uhttp', script: UHTTP_SCRIPT, entryVariable: 'CHANGE_ENTRY' },
]

type Rates = Record<Copy, number>

interface Round {
  bareRate: number
  mainRate: number
  changeRate: number
  changeVsMain: number
  changeVsBare: number
  noise: number
}

interface Summary {
  bareMedian: number
  mainMedian: number
  changeMedian: number
  moved: number
  noise: number
  threshold: number
  consistent: boolean
  changeVsBare: number
  mainVsBare: number
  roundsBeyondLimit: number
}

function requiredEntry(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(`Set ${name} to the built dist/index.js of a uhttp checkout.`)
  const path = resolve(value)
  if (!existsSync(path)) throw new Error(`${name} is ${path}, and that file is missing.`)
  return path
}

function serverSpec({ label, script, entryVariable }: CopySpec, pinned: boolean): ServerSpec {
  const env: Record<string, string> = entryVariable === undefined ? {} : { UHTTP_ENTRY: requiredEntry(entryVariable) }
  const spec = { label, script: resolve(import.meta.dirname, script), env }
  return pinned ? { ...spec, cpu: SERVER_CPU } : spec
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? Number.NaN
  if (sorted.length % 2 === 1) return upper
  return ((sorted[middle - 1] ?? Number.NaN) + upper) / 2
}

async function measureRound(servers: ReadonlyMap<Copy, RunningServer>, offset: number): Promise<Rates> {
  const rates: Rates = { bare: 0, main: 0, change: 0, bareCopy: 0, mainCopy: 0, changeCopy: 0 }
  for (let step = 0; step < COPIES.length; step++) {
    const position = COPIES[(step + offset) % COPIES.length]
    const server = position === undefined ? undefined : servers.get(position.copy)
    if (position === undefined || server === undefined)
      throw new Error(`The script started no server for position ${step + offset}.`)
    rates[position.copy] = await measure(server, COMPARE_ROUND_DURATION_MS)
  }
  return rates
}

function copyGap(original: number, copy: number): number {
  return Math.abs(original / copy - 1)
}

function toRound(rates: Rates): Round {
  const bareRate = (rates.bare + rates.bareCopy) / 2
  const mainRate = (rates.main + rates.mainCopy) / 2
  const changeRate = (rates.change + rates.changeCopy) / 2
  const noise = Math.max(
    copyGap(rates.bare, rates.bareCopy),
    copyGap(rates.main, rates.mainCopy),
    copyGap(rates.change, rates.changeCopy),
  )
  return {
    bareRate,
    mainRate,
    changeRate,
    changeVsMain: changeRate / mainRate - 1,
    changeVsBare: changeRate / bareRate - 1,
    noise,
  }
}

function beyondBareLimit(ratio: number): boolean {
  return ratio < -MAX_SLOWDOWN_FROM_BARE_RATIO
}

function summarise(rounds: readonly Round[]): Summary {
  const bareMedian = median(rounds.map(round => round.bareRate))
  const mainMedian = median(rounds.map(round => round.mainRate))
  const changeMedian = median(rounds.map(round => round.changeRate))
  const moved = changeMedian / mainMedian - 1
  const noise = median(rounds.map(round => round.noise))
  const consistent = rounds.every(round => Math.sign(round.changeVsMain) === Math.sign(moved))
  return {
    bareMedian,
    mainMedian,
    changeMedian,
    moved,
    noise,
    threshold: Math.max(noise, FLAGGED_CHANGE_FLOOR_RATIO),
    consistent,
    changeVsBare: median(rounds.map(round => round.changeVsBare)),
    mainVsBare: median(rounds.map(round => round.mainRate / round.bareRate - 1)),
    roundsBeyondLimit: rounds.filter(round => beyondBareLimit(round.changeVsBare)).length,
  }
}

function mainVerdict({ moved, threshold, consistent }: Summary, roundCount: number): string {
  const median = `Across the ${roundCount} rounds, the median speed of uhttp after this PR was ${formatGap(moved)} than its median speed before this PR.`
  const bar = `The job counts a difference only when it is larger than ${formatShare(threshold)}, which is the median machine noise or ${formatShare(FLAGGED_CHANGE_FLOOR_RATIO)}, whichever is larger.`
  if (Math.abs(moved) <= threshold) {
    return `**This PR changes the speed of uhttp by less than the machine noise.** ${median} ${bar}`
  }
  if (!consistent) {
    return `**uhttp after this PR was faster in some rounds and slower in others, so the job treats its speed as unchanged.** ${median} ${bar}`
  }
  const direction = moved < 0 ? 'slower' : 'faster'
  return `**This PR makes uhttp ${formatGap(moved)}.** ${median} uhttp after this PR was ${direction} in all ${roundCount} rounds. ${bar}`
}

function bareVerdict({ changeVsBare, mainVsBare, roundsBeyondLimit, noise }: Summary, roundCount: number): string {
  const limit = formatShare(MAX_SLOWDOWN_FROM_BARE_RATIO)
  const share = roundsBeyondLimit === roundCount ? `all ${roundCount}` : `${roundsBeyondLimit} of ${roundCount}`
  const rounds =
    roundsBeyondLimit === 0
      ? `uhttp after this PR stayed within the limit in all ${roundCount} rounds.`
      : `uhttp after this PR went past the limit in ${share} rounds.`
  const noisy = `Rerun the job before you act on this result, because the median machine noise of ${formatShare(noise)} is larger than the ${limit} limit.`
  const facts = [
    `In the median round, uhttp after this PR was ${formatGap(changeVsBare)} than uWebSockets.js on its own, while uhttp before this PR was ${formatGap(mainVsBare)}.`,
    rounds,
    ...(noise > MAX_SLOWDOWN_FROM_BARE_RATIO ? [noisy] : []),
  ].join(' ')
  if (!beyondBareLimit(changeVsBare)) {
    return `**uhttp after this PR is within ${limit} of the speed of uWebSockets.js on its own.** ${facts}`
  }
  if (beyondBareLimit(mainVsBare)) {
    return `**uhttp is more than ${limit} slower than uWebSockets.js on its own, both before and after this PR, so the job fails.** ${facts}`
  }
  return `**This PR makes uhttp more than ${limit} slower than uWebSockets.js on its own, so the job fails.** ${facts}`
}

function tableRow(label: string, cells: readonly string[]): string {
  return `| ${label} | ${cells.join(' | ')} |`
}

function table(headings: readonly string[], rows: readonly (readonly string[])[]): string {
  const divider = headings.map(() => '---:')
  const lines = [tableRow('Round', headings), tableRow('---', divider)]
  rows.forEach((cells, index) => {
    lines.push(tableRow(index === rows.length - 1 ? 'Median' : String(index + 1), cells))
  })
  return lines.join('\n')
}

function prTable(rounds: readonly Round[], summary: Summary): string {
  const headings = ['Before this PR', 'After this PR', 'Difference', 'Machine noise']
  const row = (before: number, after: number, moved: number, noise: number): string[] => [
    formatRate(before),
    formatRate(after),
    formatGap(moved),
    formatShare(noise),
  ]
  const rows = rounds.map(round => row(round.mainRate, round.changeRate, round.changeVsMain, round.noise))
  rows.push(row(summary.mainMedian, summary.changeMedian, summary.moved, summary.noise))
  return table(headings, rows)
}

function bareTable(rounds: readonly Round[], summary: Summary): string {
  const headings = ['uWebSockets.js on its own', 'uhttp after this PR', 'Difference', 'Machine noise']
  const row = (bare: number, after: number, changeVsBare: number, noise: number): string[] => [
    formatRate(bare),
    formatRate(after),
    formatGap(changeVsBare),
    formatShare(noise),
  ]
  const rows = rounds.map(round => row(round.bareRate, round.changeRate, round.changeVsBare, round.noise))
  rows.push(row(summary.bareMedian, summary.changeMedian, summary.changeVsBare, summary.noise))
  return table(headings, rows)
}

function report(rounds: readonly Round[], summary: Summary, pinned: boolean): string {
  const seconds = COMPARE_ROUND_DURATION_MS / 1_000
  const loadCpus = new Intl.ListFormat('en-US', { type: 'conjunction' }).format(LOAD_CPUS.split(','))
  const pinning = pinned
    ? `The job pins every server to CPU ${SERVER_CPU} and h2load to CPUs ${loadCpus}.`
    : 'The servers and h2load share every CPU on this machine, because the job pins processes with taskset, which Linux alone provides.'
  const warmUp =
    COMPARE_WARM_UP_ROUNDS === 1
      ? '1 warm-up round and discards its figures'
      : `${COMPARE_WARM_UP_ROUNDS} warm-up rounds and discards their figures`
  const limit = formatShare(MAX_SLOWDOWN_FROM_BARE_RATIO)
  return [
    '## Speed check',
    '',
    `The job measures three servers that answer \`GET ${ROUTE_PATH}\`: uWebSockets.js on its own, uhttp before this PR, and uhttp after this PR. Because the job starts two identical copies of each server, each figure in the tables below is the average of those two copies, in requests per second. The job first runs ${warmUp}. In each of the ${rounds.length} rounds that follow, h2load sends requests to each of the ${COPIES.length} servers for ${seconds} s from ${LOAD_THREADS} threads over ${CONNECTIONS} connections. ${pinning}`,
    '',
    'Machine noise is the largest gap between the two copies of any one server in the same round. Because each pair of copies runs identical code, a difference smaller than the machine noise can come from the machine alone.',
    '',
    '### Does this PR make uhttp slower?',
    '',
    'In the Difference column, each figure is the speed of uhttp after this PR compared with uhttp before it. The job reports this comparison without failing on it.',
    '',
    prTable(rounds, summary),
    '',
    mainVerdict(summary, rounds.length),
    '',
    '### How much slower is uhttp than uWebSockets.js on its own?',
    '',
    `In the Difference column, each figure is the speed of uhttp after this PR compared with uWebSockets.js on its own. The job fails when uhttp after this PR is more than ${limit} slower than uWebSockets.js on its own in the median round. Several PRs can each slow uhttp by less than the machine noise, so the job compares uhttp with uWebSockets.js on its own to catch their total. Both servers run the uWebSockets.js version that this PR installs, so only a change to uhttp can move the gap between them.`,
    '',
    bareTable(rounds, summary),
    '',
    bareVerdict(summary, rounds.length),
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const pinned = process.platform === 'linux'
  if (pinned) execFileSync('taskset', ['-a', '-p', '-c', LOAD_CPUS, String(process.pid)], { stdio: 'ignore' })
  const servers = new Map<Copy, RunningServer>()
  try {
    for (const copy of COPIES) servers.set(copy.copy, await startServer(serverSpec(copy, pinned)))
    for (let round = 0; round < COMPARE_WARM_UP_ROUNDS; round++) await measureRound(servers, round)
    const rounds: Round[] = []
    for (let round = 0; round < COMPARE_MEASURED_ROUNDS; round++) {
      rounds.push(toRound(await measureRound(servers, round)))
    }
    const summary = summarise(rounds)
    const text = report(rounds, summary, pinned)
    console.log(text)
    const summaryPath = process.env.GITHUB_STEP_SUMMARY
    if (summaryPath !== undefined && summaryPath !== '') appendFileSync(summaryPath, text)
    const outputPath = process.env.GITHUB_OUTPUT
    if (outputPath !== undefined && outputPath !== '') {
      appendFileSync(outputPath, `beyond_bare_limit=${beyondBareLimit(summary.changeVsBare)}\n`)
    }
  } finally {
    await Promise.all([...servers.values()].map(server => server.stop()))
  }
}

await main()
