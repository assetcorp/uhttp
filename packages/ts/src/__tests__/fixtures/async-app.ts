import { createApp } from '../../index.js'

export default async function buildApp() {
  await new Promise(resolve => setTimeout(resolve, 5))
  return createApp().get('/hello', c => c.text('Hello from an async builder'))
}
