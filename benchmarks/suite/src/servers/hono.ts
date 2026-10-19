import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { JSON_BODY, JSON_PATH, PLAIN_BODY, PLAIN_PATH, UPLOAD_PATH } from '../constants.ts'
import { announce, securityHeadersRequested } from './announce.ts'

const app = new Hono()
if (securityHeadersRequested()) app.use(secureHeaders({ strictTransportSecurity: false }))

app.get(PLAIN_PATH, c => c.text(PLAIN_BODY))
app.get(JSON_PATH, c => c.json(JSON_BODY))
app.post(UPLOAD_PATH, async c => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }))

serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, info => announce(info.port))
