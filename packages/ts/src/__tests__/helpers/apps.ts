import { createApp } from '../../index.js'

export const KIB = 1024
export const MIB = 1024 * KIB
export const GIB = 1024 * MIB

export function bodyApp(handled: string[], maxBodyBytes = 100) {
  return createApp({ maxBodyBytes })
    .get('/hello', c => c.text('Hello'))
    .get('/admin', c => {
      handled.push('admin')
      return c.text('admin')
    })
    .post('/echo', async c => {
      handled.push('echo')
      return c.text(await c.req.body.text())
    })
    .post('/count', async c => {
      handled.push('count')
      let total = 0
      for await (const chunk of c.req.body.stream()) total += chunk.byteLength
      return c.text(String(total))
    })
    .post('/ignore', { maxBodyBytes: 4 * MIB }, c => {
      handled.push('ignore')
      return c.text('ok')
    })
}
