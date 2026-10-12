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
  }
}

function mainVerdict({ moved, threshold, consistent }: Summary, roundCount: number): string {
  const median = `The median moved ${formatShare(Math.abs(moved))} against a threshold of ${formatShare(threshold)}.`
  if (Math.abs(moved) <= threshold) {
    return `**This PR changes the speed of uhttp by less than the machine noise.** ${median}`
  }
  if (!consistent) {
    return `**uhttp after this PR was faster in some rounds and slower in others, so the job treats its speed as unchanged.** ${median}`
  }
  const direction = moved < 0 ? 'slower' : 'faster'
  return `**This PR makes uhttp ${formatGap(moved)}.** uhttp after this PR was ${direction} in all ${roundCount} rounds. ${median}`
}

function bareVerdict({ changeVsBare, mainVsBare, noise }: Summary): string {
  const limit = formatShare(MAX_SLOWDOWN_FROM_BARE_RATIO)
  const noisy =
    noise > MAX_SLOWDOWN_FROM_BARE_RATIO
      ? ` Rerun the job before you act on this result, because the median machine noise of ${formatShare(noise)} is larger than the ${limit} limit.`
      : ''
  if (!beyondBareLimit(changeVsBare)) {
    return `**uhttp after this PR is within ${limit} of uWebSockets.js on its own.** Before this PR, it was ${formatGap(mainVsBare)}.${noisy}`
  }
  const figures = `After this PR, it was ${formatGap(changeVsBare)}, and before this PR, it was ${formatGap(mainVsBare)}.${noisy}`
  if (beyondBareLimit(mainVsBare)) {
    return `**uhttp is more than ${limit} slower than uWebSockets.js on its own, both before and after this PR, so the job fails.** ${figures}`
  }
  return `**This PR makes uhttp more than ${limit} slower than uWebSockets.js on its own, so the job fails.** ${figures}`
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

function report(rounds: readonly Round[], summary: Summary): string {
  const seconds = COMPARE_ROUND_DURATION_MS / 1_000
  const limit = formatShare(MAX_SLOWDOWN_FROM_BARE_RATIO)
  return [
    '## Speed check',
    '',
    `h2load sent \`GET ${ROUTE_PATH}\` to uWebSockets.js on its own, to uhttp before this PR, and to uhttp after this PR, in ${rounds.length} rounds of ${seconds} s each over ${CONNECTIONS} connections. Each figure is the average of two identical copies of a server, and machine noise is the largest gap between two copies in a round.`,
    '',
    '### Does this PR make uhttp slower?',
    '',
    'The job never fails on this table.',
    '',
    prTable(rounds, summary),
    '',
    mainVerdict(summary, rounds.length),
    '',
    '### How much slower is uhttp than uWebSockets.js on its own?',
    '',
    `The job fails when uhttp after this PR is more than ${limit} slower in the median round.`,
    '',
    bareTable(rounds, summary),
    '',
    bareVerdict(summary),
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
    const text = report(rounds, summary)
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
