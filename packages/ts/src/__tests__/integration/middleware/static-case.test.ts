import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../index.js'
import { serveStatic } from '../../../middleware/static/index.js'
import {
  caseInsensitiveFolder,
  caseInsensitiveSite,
  GUARD_BYPASS_SPELLINGS,
  OTHER_SPELLINGS,
  PUBLIC_BODY,
} from '../../helpers/case-insensitive-folder.js'

const folder = caseInsensitiveFolder()
let root = ''

describe.runIf(folder !== undefined)('serveStatic() on a folder that ignores case', () => {
  beforeAll(() => {
    if (folder !== undefined) root = caseInsensitiveSite(folder)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('serves a file under the spelling on disk alone', async () => {
    const app = createApp().use(serveStatic({ root }))
    const exact = await app.request('/Assets/Hello.txt')
    expect(exact.status).toBe(200)
    expect(await exact.text()).toBe(PUBLIC_BODY)
    for (const path of OTHER_SPELLINGS) {
      const response = await app.request(path)
      expect(response.status, path).toBe(404)
      expect(await response.text(), path).not.toContain(PUBLIC_BODY)
    }
  })

  it('serves no file when the client spells a guarded folder in another case', async () => {
    const app = createApp()
      .use((c, next) => (c.req.path.startsWith('/Admin/') ? c.text('blocked', 403) : next()))
      .use(serveStatic({ root }))
    expect((await app.request('/Admin/Report.txt')).status).toBe(403)
    for (const path of GUARD_BYPASS_SPELLINGS) {
      expect((await app.request(path)).status, path).toBe(404)
    }
  })
})
