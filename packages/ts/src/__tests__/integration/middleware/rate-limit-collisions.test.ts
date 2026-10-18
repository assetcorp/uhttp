import { describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'
import { rateLimit } from '../../../middleware/rate-limit/index.js'

const MAX_KEYS = 32768
const TABLE_SLOTS = 65536
const CLUSTER_SLOTS = 256
const KEY_COUNT = 30000
const PADDED_KEY_BYTES = 40
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
const ALLOWED_SLOWDOWN = 2

function unseededSlot(key: string): number {
  let hash = FNV_OFFSET ^ key.length
  for (let index = 0; index < PADDED_KEY_BYTES; index++) {
    hash = Math.imul(hash ^ (index < key.length ? key.charCodeAt(index) : 0), FNV_PRIME)
  }
  return (hash >>> 0) & (TABLE_SLOTS - 1)
}

function clusteredKeys(): string[] {
  const keys: string[] = []
  for (let candidate = 0; keys.length < KEY_COUNT; candidate++) {
    const key = `api-key-${candidate.toString(36)}`
    if (unseededSlot(key) < CLUSTER_SLOTS) keys.push(key)
  }
  return keys
}

function spreadKeys(): string[] {
  return Array.from({ length: KEY_COUNT }, (_, index) => `api-key-${(index * 7919).toString(36)}`)
}

async function millisecondsToCount(keys: readonly string[]): Promise<number> {
  const app = createApp()
    .use(
      rateLimit({
        limit: 1,
        windowMs: 60000,
        maxKeys: MAX_KEYS,
        headers: ['x-api-key'],
        key: c => c.req.header('x-api-key') ?? '',
      }),
    )
    .get('/', c => c.text('ok'))
  const started = performance.now()
  for (const key of keys) {
    const response = await app.request('/', { headers: { 'x-api-key': key } })
    if (response.status !== 200) throw new Error(`The first request of ${key} got ${response.status}.`)
  }
  const elapsed = performance.now() - started
  for (const key of keys.slice(-100)) {
    expect((await app.request('/', { headers: { 'x-api-key': key } })).status).toBe(429)
  }
  return elapsed
}

describe('rateLimit() built-in store against chosen keys', () => {
  it('counts 30,000 keys that collide under an unseeded hash within twice the time of 30,000 spread keys', {
    timeout: 120_000,
  }, async () => {
    const clustered = clusteredKeys()
    const spread = spreadKeys()
    expect(new Set(clustered.map(unseededSlot)).size).toBeLessThanOrEqual(CLUSTER_SLOTS)
    await millisecondsToCount(spread.slice(0, 2000))

    const spreadMs = await millisecondsToCount(spread)
    const clusteredMs = await millisecondsToCount(clustered)

    expect(clusteredMs).toBeLessThan(spreadMs * ALLOWED_SLOWDOWN)
  })
})
