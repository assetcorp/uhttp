import { createApp } from '../../index.js'

export default function buildApp() {
  createApp({ maxBodyBytes: -1 })
  return createApp()
}
