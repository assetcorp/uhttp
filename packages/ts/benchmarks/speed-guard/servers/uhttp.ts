import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Uhttp from '../../../src/index.ts'
import { ROUTE_BODY, ROUTE_PATH } from '../constants.ts'

const entry = process.env.UHTTP_ENTRY ?? resolve(import.meta.dirname, '../../../dist/index.js')
const { createApp, serve } = (await import(pathToFileURL(entry).href)) as typeof Uhttp

const app = createApp().get(ROUTE_PATH, c => c.text(ROUTE_BODY))
const server = await serve({ app, port: 0, host: '127.0.0.1' })
console.log(JSON.stringify({ port: server.port }))
