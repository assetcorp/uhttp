import { CPU_USAGE_REQUEST, HEADER_VARIANT_ENV } from '../constants.ts'

export function securityHeadersRequested(): boolean {
  const variant = process.env[HEADER_VARIANT_ENV]
  if (variant === 'secure') return true
  if (variant === 'plain') return false
  throw new Error(`Set ${HEADER_VARIANT_ENV} to 'plain' or 'secure' before you start a benchmark server.`)
}

export function announce(port: number): void {
  process.on('message', message => {
    if (message === CPU_USAGE_REQUEST) process.send?.({ cpuUsage: process.cpuUsage() })
  })
  console.log(JSON.stringify({ port }))
}

export function failToListen(name: string): never {
  console.error(`The ${name} server failed to listen on 127.0.0.1.`)
  process.exit(1)
}
