import { threadId } from 'node:worker_threads'
import { createApp } from '../../index.js'
import { rateLimit } from '../../middleware/rate-limit/index.js'

export const SHARED_LIMIT = 10

const perMinute = rateLimit({ limit: SHARED_LIMIT, windowMs: 60_000 })

export default function buildApp() {
  const app = createApp().get('/thread', c => c.text(String(threadId)))
  app.group('/limited', perMinute).get('/', c => c.text(String(threadId)))
  return app
}
