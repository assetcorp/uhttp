import type { TemplatedApp } from 'uWebSockets.js'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { compiledOf, setPublisher } from '../app.js'
import { WORKER_FAILURE_EXIT_CODE } from '../constants.js'
import { UhttpError } from '../errors.js'
import { importApp } from '../serve/module.js'
import { loadUws, registerApp } from '../serve/native.js'
import type { Hub } from '../websocket/hub.js'
import { isMainMessage, type MainMessage, serializedError, type WorkerMessage, type WorkerSetup } from './messages.js'
import { ThreadRelay } from './relay.js'

interface Serving {
  readonly native: TemplatedApp
  readonly hub: Hub | undefined
  readonly relay: ThreadRelay | undefined
  readonly leaveApp: () => void
}

let serving: Serving | undefined
let pendingNative: TemplatedApp | undefined
let exiting = false
let leaveRequested = false

function post(message: WorkerMessage): void {
  parentPort?.postMessage(message)
}

function closeAndExit(message: WorkerMessage): void {
  if (exiting) return
  exiting = true
  post(message)
  const native = serving?.native ?? pendingNative
  try {
    native?.close()
  } catch {
    process.exit(WORKER_FAILURE_EXIT_CODE)
  }
  setImmediate(() => process.exit(WORKER_FAILURE_EXIT_CODE))
}

function crash(error: unknown): void {
  closeAndExit({ type: 'crashed', error: serializedError(error) })
}

function fail(error: unknown): void {
  closeAndExit({ type: 'failed', error: serializedError(error) })
}

function setupOf(value: unknown): WorkerSetup | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const module: unknown = Reflect.get(value, 'module')
  const origin: unknown = Reflect.get(value, 'origin')
  if (typeof module !== 'string' || !(origin instanceof Uint8Array)) return undefined
  return { module, origin }
}

async function leave(): Promise<void> {
  const current = serving
  serving = undefined
  if (current === undefined) {
    process.exit(0)
    return
  }
  current.leaveApp()
  current.relay?.close()
  await current.hub?.close()
  current.native.close()
  parentPort?.close()
  setImmediate(() => process.exit(0))
}

function receive(message: MainMessage): void {
  switch (message.type) {
    case 'ping':
      post({ type: 'pong' })
      return
    case 'leave':
      if (serving === undefined) leaveRequested = true
      else post({ type: 'leaving' })
      return
    case 'left':
      void leave()
      return
    case 'peer':
      if (serving?.relay === undefined) message.port.close()
      else serving.relay.addPeer(message.id, message.port)
      return
    case 'peer-gone':
      serving?.relay?.removePeer(message.id)
  }
}

async function start(setup: WorkerSetup): Promise<void> {
  let app: Awaited<ReturnType<typeof importApp>>
  try {
    app = await importApp(new URL(setup.module))
  } catch (error) {
    fail(error)
    return
  }
  const compiled = compiledOf(app)
  const uws = loadUws()
  const native = uws.App()
  pendingNative = native
  const hub = await registerApp(uws, native, compiled, setup.origin)
  const relay = hub === undefined ? undefined : new ThreadRelay(hub)
  if (hub !== undefined) hub.relay = relay
  await hub?.start()
  if (leaveRequested) {
    await hub?.close()
    native.close()
    process.exit(0)
    return
  }
  if (hub !== undefined) setPublisher(app, (topic, message, options) => hub.publish(topic, message, options))
  serving = { native, hub, relay, leaveApp: () => setPublisher(app, undefined) }
  post({ type: 'ready', descriptor: native.getDescriptor() })
}

if (!isMainThread && parentPort !== null) {
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)
  parentPort.on('message', (message: unknown) => {
    if (isMainMessage(message)) receive(message)
  })
  const setup = setupOf(workerData)
  if (setup === undefined) fail(new UhttpError('APP_START_FAILED', 'The worker thread received no app module.'))
  else start(setup).catch(fail)
}
