import { createApp, serve } from '@delali/uhttp'
import { secureHeaders } from '@delali/uhttp/secure-headers'
import { JSON_BODY, JSON_PATH, PLAIN_BODY, PLAIN_PATH, UPLOAD_PATH } from '../constants.ts'
import { announce, failToListen, wantsSecurityHeaders } from './announce.ts'

const app = createApp()
if (wantsSecurityHeaders()) app.use(secureHeaders())

app
  .get(PLAIN_PATH, c => c.text(PLAIN_BODY))
  .get(JSON_PATH, c => c.json(JSON_BODY))
  .post(UPLOAD_PATH, async c => c.json({ bytes: (await c.req.body.bytes()).byteLength }))

const server = await serve({ app, port: 0, host: '127.0.0.1' })
if (server.port === undefined) failToListen('uhttp')
announce(server.port)
