import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type } from 'arktype'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, type StandardSchemaV1 } from '../../../index.js'
import { memoryLogger } from '../../helpers/server.js'

interface ErrorBody {
  error: { code: string; message: string; issues?: { message: string; path: (string | number)[] }[] }
}

function post(body: string) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body }
}

const schemas: Record<string, StandardSchemaV1<unknown, { name: string; age: number }>> = {
  Valibot: v.object({ name: v.string(), age: v.number() }),
  Zod: z.object({ name: z.string(), age: z.number() }),
  ArkType: type({ name: 'string', age: 'number' }),
}

describe('json(schema) with a Standard Schema validator', () => {
  for (const [library, schema] of Object.entries(schemas)) {
    it(`returns the output of a ${library} schema for a valid body`, async () => {
      const app = createApp().post('/users', async c => {
        const user = await c.req.body.json(schema)
        return c.json({ greeting: `${user.name} is ${user.age}` })
      })

      const response = await app.request('/users', post('{"name":"Ama","age":30}'))

      expect(await response.json()).toEqual({ greeting: 'Ama is 30' })
    })

    it(`answers 400 with VALIDATION_FAILED and the problems from ${library}`, async () => {
      const app = createApp().post('/users', async c => c.json(await c.req.body.json(schema)))

      const response = await app.request('/users', post('{"name":42}'))
      const body = (await response.json()) as ErrorBody

      expect(response.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_FAILED')
      expect(body.error.issues?.length).toBeGreaterThan(0)
      expect(body.error.issues?.some(issue => issue.path.includes('name'))).toBe(true)
    })
  }

  it('returns the value that the schema transforms', async () => {
    const schema = v.pipe(
      v.object({ email: v.string() }),
      v.transform(input => ({ email: input.email.toLowerCase() })),
    )
    const app = createApp().post('/users', async c => c.json(await c.req.body.json(schema)))

    const response = await app.request('/users', post('{"email":"AMA@EXAMPLE.COM"}'))

    expect(await response.json()).toEqual({ email: 'ama@example.com' })
  })

  it('caps the list of problems at 10 and the length of each message', async () => {
    const longMessage = 'x'.repeat(5000)
    const schema: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({
          issues: Array.from({ length: 50_000 }, (_, index) => ({ message: longMessage, path: [index] })),
        }),
      },
    }
    const app = createApp().post('/bulk', async c => c.json(await c.req.body.json(schema)))

    const response = await app.request('/bulk', post('[]'))
    const text = await response.text()
    const body = JSON.parse(text) as ErrorBody

    expect(body.error.issues).toHaveLength(10)
    expect(body.error.issues?.[0]?.message.length).toBeLessThanOrEqual(256)
    expect(text.length).toBeLessThan(4_000)
  })

  it('keeps every problem small even when Zod reports one per element of a 200 KB body', async () => {
    const schema = z.array(z.string())
    const app = createApp().post('/bulk', async c => c.json(await c.req.body.json(schema)))
    const numbers = `[${Array.from({ length: 50_000 }, () => '1').join(',')}]`

    const response = await app.request('/bulk', post(numbers))

    expect(response.status).toBe(400)
    expect((await response.text()).length).toBeLessThan(4_000)
  })

  it('awaits an asynchronous validator', async () => {
    const schema: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async value => (typeof value === 'string' ? { value: value.toUpperCase() } : { issues: [] }),
      },
    }
    const app = createApp().post('/shout', async c => c.text(await c.req.body.json(schema)))

    expect(await (await app.request('/shout', post('"akwaaba"'))).text()).toBe('AKWAABA')
  })

  it('answers 500 and logs the error when the validator throws or rejects', async () => {
    const { entries, logger } = memoryLogger()
    const throwing: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => {
          throw new Error('validator bug')
        },
      },
    }
    const rejecting: StandardSchemaV1<unknown, unknown> = {
      '~standard': { version: 1, vendor: 'test', validate: () => Promise.reject(new Error('validator bug')) },
    }
    const app = createApp({ logger })
      .post('/throws', async c => c.json(await c.req.body.json(throwing)))
      .post('/rejects', async c => c.json(await c.req.body.json(rejecting)))

    const thrown = await app.request('/throws', post('{}'))
    const rejected = await app.request('/rejects', post('{}'))

    expect(thrown.status).toBe(500)
    expect(rejected.status).toBe(500)
    expect(entries.map(entry => (entry.details.err as { code?: string }).code)).toEqual([
      'INVALID_SCHEMA',
      'INVALID_SCHEMA',
    ])
  })

  it('lists no validator among the dependencies of the package', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../../package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>
    const runtime = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }

    for (const name of ['valibot', 'zod', 'arktype', '@standard-schema/spec']) {
      expect(runtime[name]).toBeUndefined()
    }
  })
})
