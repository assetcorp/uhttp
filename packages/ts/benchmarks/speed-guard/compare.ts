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
  formatRate,
  formatShare,
  formatSignedPercent,
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
  { copy: 'bare', label: 'bare uWebSockets.js', script: BARE_SCRIPT },
  { copy: 'main', label: 'main', script: UHTTP_SCRIPT, entryVariable: 'BASE_ENTRY' },
  { copy: 'change', label: 'change', script: UHTTP_SCRIPT, entryVariable: 'CHANGE_ENTRY' },
  { copy: 'bareCopy', label: 'bare uWebSockets.js copy', script: BARE_SCRIPT },
  { copy: 'mainCopy', label: 'main copy', script: UHTTP_SCRIPT, entryVariable: 'BASE_ENTRY' },
  { copy: 'changeCopy', label: 'change copy', script: UHTTP_SCRIPT, entryVariable: 'CHANGE_ENTRY' },
]

type Rates = Record<Copy, number>

interface Round extends Rates {
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
    ...rates,
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

function mainVerdict({ moved, threshold, consistent }: Summary): string {
  const movement = `The median of the change differs from the median of main by ${formatSignedPercent(moved)}, and the threshold is ${formatShare(threshold)}, which is the larger of the copy noise and ${formatShare(FLAGGED_CHANGE_FLOOR_RATIO)}.`
  if (Math.abs(moved) <= threshold) return `**The difference from main is within the noise.** ${movement}`
  if (!consistent) {
    return `**The difference from main changes sign between rounds, so the job flags nothing.** ${movement}`
  }
  const direction = moved < 0 ? 'slower' : 'faster'
  return `**The change is ${formatShare(Math.abs(moved))} ${direction} than main, and it is ${direction} in every round.** ${movement}`
}

function describeGap(ratio: number): string {
  return `${formatShare(Math.abs(ratio))} ${ratio < 0 ? 'slower' : 'faster'}`
}

function bareVerdict({ changeVsBare, mainVsBare, roundsBeyondLimit, noise }: Summary, roundCount: number): string {
  const limit = `the limit of a ${formatShare(MAX_SLOWDOWN_FROM_BARE_RATIO)} slowdown from bare uWebSockets.js`
  const noisy = `The copy noise of ${formatShare(noise)} is larger than the limit, so rerun the job before you act on this result.`
  const gaps = [
    `In the median round, the change is ${describeGap(changeVsBare)} than bare uWebSockets.js, and main is ${describeGap(mainVsBare)}.`,
    `The change is beyond the limit in ${roundsBeyondLimit} of ${roundCount} rounds.`,
    ...(noise > MAX_SLOWDOWN_FROM_BARE_RATIO ? [noisy] : []),
  ].join(' ')
  if (!beyondBareLimit(changeVsBare)) return `**The change is inside ${limit}.** ${gaps}`
  if (beyondBareLimit(mainVsBare)) {
    return `**The change is beyond ${limit}, and main was beyond it already, so the job fails.** ${gaps}`
  }
  return `**This change takes uhttp beyond ${limit}, so the job fails.** ${gaps}`
}

function table(rounds: readonly Round[], summary: Summary): string {
  const lines = [
    '| Round | bare | bare copy | main | main copy | change | change copy | change vs main | change vs bare | copy noise |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  rounds.forEach((round, index) => {
    const rates = [round.bare, round.bareCopy, round.main, round.mainCopy, round.change, round.changeCopy]
      .map(formatRate)
      .join(' | ')
    const ratios = [round.changeVsMain, round.changeVsBare].map(formatSignedPercent).join(' | ')
    lines.push(`| ${index + 1} | ${rates} | ${ratios} | ${formatShare(round.noise)} |`)
  })
  const medians = [summary.bareMedian, summary.mainMedian, summary.changeMedian].map(formatRate).join(' | | ')
  const ratios = [summary.moved, summary.changeVsBare].map(formatSignedPercent).join(' | ')
  lines.push(`| Median | ${medians} | | ${ratios} | ${formatShare(summary.noise)} |`)
  return lines.join('\n')
}

function report(rounds: readonly Round[], summary: Summary, pinned: boolean): string {
  const seconds = COMPARE_ROUND_DURATION_MS / 1_000
  const pinning = pinned
    ? `The job pinned every server to CPU ${SERVER_CPU} and the load generator to CPUs ${LOAD_CPUS}.`
    : 'The job pinned no process to a CPU, because taskset exists on Linux alone.'
  const warmUp = COMPARE_WARM_UP_ROUNDS === 1 ? '1 warm-up round' : `${COMPARE_WARM_UP_ROUNDS} warm-up rounds`
  return [
    '## Speed compared with main and with bare uWebSockets.js',
    '',
    `In each of ${rounds.length} rounds, autocannon sent \`GET ${ROUTE_PATH}\` to each of ${COPIES.length} servers for ${seconds} s at ${CONNECTIONS} connections, after the job had discarded ${warmUp}. ${pinning} The copy noise is the largest gap between two identical copies of one server.`,
    '',
    `The bare uWebSockets.js server answers the same route without uhttp, using the uWebSockets.js that the change installs. Its speed stays the same whatever a pull request changes in uhttp, so the job fails once uhttp is more than ${formatShare(MAX_SLOWDOWN_FROM_BARE_RATIO)} slower than that server in the median round, even when every earlier pull request was within the noise of main. The comparison with main never fails the job.`,
    '',
    table(rounds, summary),
    '',
    mainVerdict(summary),
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
