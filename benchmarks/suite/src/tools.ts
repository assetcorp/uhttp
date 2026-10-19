import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const runFile = promisify(execFile)

export function pinnedCommand(cpus: string | null, program: string, args: readonly string[]): [string, string[]] {
  return cpus === null ? [program, [...args]] : ['taskset', ['-c', cpus, program, ...args]]
}
