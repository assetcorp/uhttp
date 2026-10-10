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
  ROUTE_PATH,
  SERVER_CPU,
} from './constants.ts'
import { formatRate, formatShare, formatSignedPercent, measure, type RunningServer, startServer } from './harness.ts'

type Copy = 'main' | 'change' | 'mainCopy' | 'changeCopy'

const COPIES: readonly { copy: Copy; label: string; entryVariable: string }[] = [
  { copy: 'main', label: 'main', entryVariable: 'BASE_ENTRY' },
  { copy: 'change', label: 'change', entryVariable: 'CHANGE_ENTRY' },
  { copy: 'mainCopy', label: 'main copy', entryVariable: 'BASE_ENTRY' },
  { copy: 'changeCopy', label: 'change copy', entryVariable: 'CHANGE_ENTRY' },
]

type Rates = Record<Copy, number>

interface Round extends Rates {
  mainRate: number
  changeRate: number
  changeVsMain: number
  noise: number
}

interface Summary {
  mainMedian: number
  changeMedian: number
  moved: number
  noise: number
  threshold: number
  consistent: boolean
}

function requiredEntry(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(`Set ${name} to the built dist/index.js of a uhttp checkout.`)
  const path = resolve(value)
  if (!existsSync(path)) throw new Error(`${name} is ${path}, and that file is missing.`)
  return path
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? Number.NaN
  if (sorted.length % 2 === 1) return upper
  return ((sorted[middle - 1] ?? Number.NaN) + upper) / 2
}

async function measureRound(servers: ReadonlyMap<Copy, RunningServer>, offset: number): Promise<Rates> {
  const rates: Rates = { main: 0, change: 0, mainCopy: 0, changeCopy: 0 }
  for (let step = 0; step < COPIES.length; step++) {
    const position = COPIES[(step + offset) % COPIES.length]
    const server = position === undefined ? undefined : servers.get(position.copy)
    if (position === undefined || server === undefined)
      throw new Error(`The script started no server for position ${step + offset}.`)
    rates[position.copy] = await measure(server, COMPARE_ROUND_DURATION_MS)
  }
  return rates
}

function toRound(rates: Rates): Round {
  const mainRate = (rates.main + rates.mainCopy) / 2
  const changeRate = (rates.change + rates.changeCopy) / 2
  const noise = Math.max(Math.abs(rates.main / rates.mainCopy - 1), Math.abs(rates.change / rates.changeCopy - 1))
  return { ...rates, mainRate, changeRate, changeVsMain: changeRate / mainRate - 1, noise }
}

function summarise(rounds: readonly Round[]): Summary {
  const mainMedian = median(rounds.map(round => round.mainRate))
  const changeMedian = median(rounds.map(round => round.changeRate))
  const moved = changeMedian / mainMedian - 1
  const noise = median(rounds.map(round => round.noise))
  const consistent = rounds.every(round => Math.sign(round.changeVsMain) === Math.sign(moved))
  return { mainMedian, changeMedian, moved, noise, threshold: Math.max(noise, FLAGGED_CHANGE_FLOOR_RATIO), consistent }
}

function verdict({ moved, threshold, consistent }: Summary): string {
  const movement = `The median of the change differs from the median of main by ${formatSignedPercent(moved)}, and the threshold is ${formatShare(threshold)}, which is the larger of the copy noise and ${formatShare(FLAGGED_CHANGE_FLOOR_RATIO)}.`
  if (Math.abs(moved) <= threshold) return `**The difference from main is within the noise.** ${movement}`
  if (!consistent) {
    return `**The difference from main changes sign between rounds, so the job flags nothing.** ${movement}`
  }
  const direction = moved < 0 ? 'slower' : 'faster'
  return `**The change is ${formatShare(Math.abs(moved))} ${direction} than main, and it is ${direction} in every round.** ${movement}`
}

function table(rounds: readonly Round[], summary: Summary): string {
  const lines = [
    '| Round | main | main copy | change | change copy | change vs main | copy noise |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  rounds.forEach((round, index) => {
    const rates = [round.main, round.mainCopy, round.change, round.changeCopy].map(formatRate).join(' | ')
    lines.push(`| ${index + 1} | ${rates} | ${formatSignedPercent(round.changeVsMain)} | ${formatShare(round.noise)} |`)
  })
  const medians = `${formatRate(summary.mainMedian)} | | ${formatRate(summary.changeMedian)} | |`
  lines.push(`| Median | ${medians} ${formatSignedPercent(summary.moved)} | ${formatShare(summary.noise)} |`)
  return lines.join('\n')
}

function report(rounds: readonly Round[], pinned: boolean): string {
  const summary = summarise(rounds)
  const seconds = COMPARE_ROUND_DURATION_MS / 1_000
  const pinning = pinned
    ? `The job pinned every server to CPU ${SERVER_CPU} and the load generator to CPUs ${LOAD_CPUS}.`
    : 'The job pinned no process to a CPU, because taskset exists on Linux alone.'
  const warmUp = COMPARE_WARM_UP_ROUNDS === 1 ? '1 warm-up round' : `${COMPARE_WARM_UP_ROUNDS} warm-up rounds`
  return [
    '## Speed compared with main',
    '',
    `In each of ${rounds.length} rounds, autocannon sent \`GET ${ROUTE_PATH}\` to each of ${COPIES.length} servers for ${seconds} s at ${CONNECTIONS} connections, after the job had discarded ${warmUp}. ${pinning} The copy noise is the larger gap between the two identical copies of main and of the change. This job passes whatever the table contains.`,
    '',
    table(rounds, summary),
    '',
    verdict(summary),
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const pinned = process.platform === 'linux'
  if (pinned) execFileSync('taskset', ['-a', '-p', '-c', LOAD_CPUS, String(process.pid)], { stdio: 'ignore' })
  const script = resolve(import.meta.dirname, 'servers/uhttp.ts')
  const servers = new Map<Copy, RunningServer>()
  try {
    for (const { copy, label, entryVariable } of COPIES) {
      const env = { UHTTP_ENTRY: requiredEntry(entryVariable) }
      servers.set(copy, await startServer(pinned ? { label, script, env, cpu: SERVER_CPU } : { label, script, env }))
    }
    for (let round = 0; round < COMPARE_WARM_UP_ROUNDS; round++) await measureRound(servers, round)
    const rounds: Round[] = []
    for (let round = 0; round < COMPARE_MEASURED_ROUNDS; round++) {
      rounds.push(toRound(await measureRound(servers, round)))
    }
    const summary = report(rounds, pinned)
    console.log(summary)
    const summaryPath = process.env.GITHUB_STEP_SUMMARY
    if (summaryPath !== undefined && summaryPath !== '') appendFileSync(summaryPath, summary)
  } finally {
    await Promise.all([...servers.values()].map(server => server.stop()))
  }
}

await main()
