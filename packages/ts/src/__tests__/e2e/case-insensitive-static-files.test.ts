import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../index.js'
import { serveStatic } from '../../middleware/static/index.js'
import {
  caseInsensitiveFolder,
  caseInsensitiveSite,
  GUARD_BYPASS_SPELLINGS,
  OTHER_SPELLINGS,
  PUBLIC_BODY,
} from '../helpers/case-insensitive-folder.js'
import { openConnection, requestHead } from '../helpers/http-client.js'
import { expectHello } from '../helpers/replies.js'
import { start } from '../helpers/server.js'

const folder = caseInsensitiveFolder()
let root = ''

function guardedApp() {
  return createApp()
    .use((c, next) => (c.req.path.startsWith('/Admin/') ? c.text('blocked', 403) : next()))
    .use(serveStatic({ root }))
    .get('/hello', c => c.text('Hello'))
}

describe.runIf(folder !== undefined)('static files from a folder that ignores case, over the network', () => {
  beforeAll(() => {
    if (folder !== undefined) root = caseInsensitiveSite(folder)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('sends a file under the spelling on disk alone, and replies 404 to every other spelling on one connection', async () => {
    const server = await start(guardedApp())
    const connection = await openConnection(server.port)

    const exact = await connection.exchange(requestHead('GET', '/Assets/Hello.txt'))
    expect(exact.status).toBe(200)
    expect(exact.body.toString()).toBe(PUBLIC_BODY)
    for (const path of OTHER_SPELLINGS) {
      const response = await connection.exchange(requestHead('GET', path))
      expect(response.status, path).toBe(404)
      expect(response.body.toString(), path).not.toContain(PUBLIC_BODY)
    }
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })

  it('replies 403 to the guarded folder and 404 to its other spellings, and keeps the connection open', async () => {
    const server = await start(guardedApp())
    const connection = await openConnection(server.port)

    expect((await connection.exchange(requestHead('GET', '/Admin/Report.txt'))).status).toBe(403)
    for (const path of GUARD_BYPASS_SPELLINGS) {
      const response = await connection.exchange(requestHead('GET', path))
      expect(response.status, path).toBe(404)
      expect(response.body.toString(), path).not.toContain('Quarterly revenue')
    }
    await expectHello(connection)
    expect(connection.state).toBe('open')
  })
})
