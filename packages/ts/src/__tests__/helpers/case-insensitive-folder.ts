import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CASE_INSENSITIVE_FOLDER_VARIABLE = 'UHTTP_CASE_INSENSITIVE_FOLDER'
export const GUARDED_FILE = 'Report.txt'
export const PUBLIC_FILE = 'Hello.txt'
export const PUBLIC_BODY = 'Hello from the folder that ignores case'

function ignoresCase(folder: string): boolean {
  const probe = mkdtempSync(join(folder, 'uhttp-case-probe-'))
  try {
    writeFileSync(join(probe, 'Probe'), '')
    return existsSync(join(probe, 'PROBE'))
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

export function caseInsensitiveFolder(): string | undefined {
  const configured = process.env[CASE_INSENSITIVE_FOLDER_VARIABLE]
  if (configured !== undefined && configured !== '') {
    if (!ignoresCase(configured)) {
      throw new Error(`${CASE_INSENSITIVE_FOLDER_VARIABLE} is ${configured}, a folder that matches file names by case.`)
    }
    return configured
  }
  if (ignoresCase(tmpdir())) return tmpdir()
  if (process.env.CI !== undefined) {
    throw new Error(
      `Set ${CASE_INSENSITIVE_FOLDER_VARIABLE} to a folder that ignores case, so that CI runs these tests.`,
    )
  }
  return undefined
}

export function caseInsensitiveSite(folder: string): string {
  const base = mkdtempSync(join(folder, 'uhttp-static-case-'))
  mkdirSync(join(base, 'Assets'))
  mkdirSync(join(base, 'Admin'))
  writeFileSync(join(base, 'Assets', PUBLIC_FILE), PUBLIC_BODY)
  writeFileSync(join(base, 'Admin', GUARDED_FILE), 'Quarterly revenue')
  return base
}

export const OTHER_SPELLINGS: readonly string[] = [
  '/assets/hello.txt',
  '/ASSETS/Hello.txt',
  '/Assets/hello.TXT',
  '/assets/Hello.txt',
  '/Assets/HELLO.txt',
]

export const GUARD_BYPASS_SPELLINGS: readonly string[] = ['/admin/Report.txt', '/ADMIN/Report.txt', '/aDMIN/report.txt']
