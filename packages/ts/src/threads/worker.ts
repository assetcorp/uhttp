import type { TemplatedApp } from 'uWebSockets.js'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { compiledOf, setPublisher } from '../app.js'
import { WORKER_FAILURE_EXIT_CODE } from '../constants.js'
import { UhttpError } from '../errors.js'
import { Drain, type LeavingMode } from '../native/drain.js'
import { withinGrace } from '../serve/grace.js'
import { importApp } from '../serve/module.js'
import { hubOf, loadUws, nativeAppOf, registerApp } from '../serve/native.js'
import { isCheckedTls } from '../serve/tls-options.js'
import type { Hub } from '../websocket/hub.js'
import { isMainMessage, type MainMessage, serializedError, type WorkerMessage, type WorkerSetup } from './messages.js'
import { ThreadRelay } from './relay.js'

interface Serving {
  readonly native: TemplatedApp
  readonly drain: Drain
  readonly hub: Hub | undefined
  readonly relay: ThreadRelay | undefined
  readonly leaveApp: () => void
}

interface DrainRequest {
  readonly mode: LeavingMode
  readonly graceMs: number
}

let serving: Serving | undefined
let pendingNative: TemplatedApp | undefined
let exitFlag: Int32Array | undefined
let requestedDrain: DrainRequest | undefined
let draining = false
let exiting = false
let nativeClosed = false

function post(message: WorkerMessage): void {
  parentPort?.postMessage(message)
}

function closeNative(): void {
  if (nativeClosed) return
  nativeClosed = true
  ;(serving?.native ?? pendingNative)?.close()
}

function signalExit(): void {
  if (exitFlag === undefined) return
  Atomics.store(exitFlag, 0, 1)
  Atomics.notify(exitFlag, 0)
}

function exitWith(code: number): void {
  signalExit()
  process.exit(code)
}

function closeAndExit(message: WorkerMessage): void {
  if (exiting) return
  exiting = true
  post(message)
  try {
    closeNative()
  } catch {
    exitWith(WORKER_FAILURE_EXIT_CODE)
  }
  setImmediate(() => exitWith(WORKER_FAILURE_EXIT_CODE))
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
  const tls: unknown = Reflect.get(value, 'tls')
  const flag: unknown = Reflect.get(value, 'exitFlag')
  if (typeof module !== 'string' || !(origin instanceof Uint8Array) || !(flag instanceof Int32Array)) return undefined
  if (tls === undefined) return { module, origin, tls: undefined, exitFlag: flag }
  return isCheckedTls(tls) ? { module, origin, tls, exitFlag: flag } : undefined
}

async function drainAndExit(request: DrainRequest): Promise<void> {
  const current = serving
  if (current === undefined) {
    requestedDrain = request
    return
  }
  const drained = current.drain.start(request.mode)
  if (draining) return
  draining = true
  await withinGrace(drained, request.graceMs)
  current.leaveApp()
  current.relay?.close()
  await current.hub?.close()
  closeNative()
  parentPort?.close()
  setImmediate(() => exitWith(0))
}

function exitNow(): void {
  exiting = true
  try {
    closeNative()
  } finally {
    setImmediate(signalExit)
  }
}

function receive(message: MainMessage): void {
  switch (message.type) {
    case 'ping':
      post({ type: 'pong' })
      return
    case 'drain':
      void drainAndExit({ mode: message.mode, graceMs: message.graceMs })
      return
    case 'exit':
      exitNow()
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
  const native = await nativeAppOf(uws, setup.tls, true)
  pendingNative = native
  const drain = new Drain()
  const hub = await hubOf(native, compiled, setup.origin)
  await registerApp(uws, native, compiled, hub, drain, setup.tls)
  const relay = hub === undefined ? undefined : new ThreadRelay(hub)
  if (hub !== undefined) hub.relay = relay
  await hub?.start()
  if (requestedDrain !== undefined || exiting) {
    await hub?.close()
    closeNative()
    exitWith(0)
    return
  }
  if (hub !== undefined) setPublisher(app, (topic, message, options) => hub.publish(topic, message, options))
  serving = { native, drain, hub, relay, leaveApp: () => setPublisher(app, undefined) }
  post({ type: 'ready', descriptor: native.getDescriptor(), secure: setup.tls !== undefined })
}

if (!isMainThread && parentPort !== null) {
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)
  parentPort.on('message', (message: unknown) => {
    if (isMainMessage(message)) receive(message)
  })
  const setup = setupOf(workerData)
  exitFlag = setup?.exitFlag
  if (setup === undefined) fail(new UhttpError('APP_START_FAILED', 'The worker thread received no app module.'))
  else start(setup).catch(fail)
}
