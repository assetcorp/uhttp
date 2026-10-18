import type { AppDescriptor } from 'uWebSockets.js'
import { Worker } from 'node:worker_threads'
import type { CheckedServeOptions } from '../serve/options.js'
import { releaseLocksOf } from './memory.js'
import { isWorkerMessage, type WorkerMessage, type WorkerSetup } from './messages.js'
import type { RestartSlot } from './restarts.js'

const WORKER_ENTRY = new URL('./worker.js', import.meta.url)

/**
 * A worker thread moves through these states, from its start to its exit.
 *
 * @internal
 */
export type WorkerState = 'starting' | 'serving' | 'leaving' | 'gone'

/**
 * The supervisor stores these values for each worker thread.
 *
 * @internal
 */
export interface WorkerRecord {
  /** The supervisor numbers each worker with this ID. */
  readonly id: number
  /** This is the worker thread of Node.js. */
  readonly worker: Worker
  /** The supervisor starts a replacement in this slot after the worker crashes. */
  readonly slot: RestartSlot
  /** The promise resolves once the worker builds its app, or rejects when the worker fails before that. */
  readonly ready: PromiseWithResolvers<void>
  /** The promise resolves once the worker exits. */
  readonly exited: Promise<void>
  /** The worker sets the first element of this shared array to 1 once it closes its connections. */
  readonly exitFlag: Int32Array
  /** The worker is in this state. */
  state: WorkerState
  /** The app of uWebSockets.js on the worker has this descriptor once the worker builds the app. */
  descriptor: AppDescriptor | undefined
  /** The worker sent its last reply to a ping at this time, from `performance.now()`. */
  lastPong: number
  /** This is `true` for a worker of a reload until that reload replaces the old workers. */
  held: boolean
  /** The watchdog pings the worker while this is `true`, from the moment that the worker serves, including while it finishes its requests after a reload. */
  watched: boolean
  /** This is `true` once the main thread marks the worker as hung. */
  hung: boolean
  /** This timer fires once the worker takes longer than `workerStartTimeoutMs` to build its app. The field is `undefined` when no timer is pending. */
  startDeadline: NodeJS.Timeout | undefined
}

/**
 * The main thread passes each worker these values, apart from the ones that the supervisor adds.
 *
 * @internal
 */
export type SharedSetup = Pick<WorkerSetup, 'module' | 'origin' | 'memory'>

/**
 * The supervisor receives the events of each worker through these functions.
 *
 * @internal
 */
export interface WorkerEvents {
  /** The worker posts a valid message. */
  message(record: WorkerRecord, message: WorkerMessage): void
  /** The worker throws an error that no code catches. */
  error(record: WorkerRecord, error: Error): void
  /** The worker exits with this code. */
  exit(record: WorkerRecord, code: number): void
}

/**
 * Returns a promise that settles with `undefined` once another promise settles either way.
 *
 * @param promise - The package passes the promise.
 * @returns The function returns a promise that never rejects.
 * @internal
 */
export function settled(promise: Promise<void>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  )
}

/**
 * Starts a worker thread with the setup of the server, and passes each of its events on.
 *
 * @param id - The supervisor passes the ID of the worker.
 * @param slot - The supervisor passes the slot of the worker.
 * @param held - The supervisor passes `true` for a worker of a reload.
 * @param options - The package passes the checked options of the server.
 * @param setup - The package passes the module URL and the origin bytes for every worker.
 * @param events - The supervisor passes the functions that receive the events of the worker.
 * @returns The function returns the record of the worker.
 * @internal
 */
export function startWorker(
  id: number,
  slot: RestartSlot,
  held: boolean,
  options: CheckedServeOptions,
  setup: SharedSetup,
  events: WorkerEvents,
): WorkerRecord {
  const heap = options.workerHeapMb
  const exitFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const workerData: WorkerSetup = { ...setup, tls: options.tls, exitFlag }
  const worker = new Worker(WORKER_ENTRY, {
    workerData,
    resourceLimits: heap === undefined ? undefined : { maxOldGenerationSizeMb: heap },
  })
  const ready = Promise.withResolvers<void>()
  void settled(ready.promise)
  const exit = Promise.withResolvers<void>()
  const record: WorkerRecord = {
    id,
    worker,
    slot,
    ready,
    exited: exit.promise,
    exitFlag,
    state: 'starting',
    descriptor: undefined,
    lastPong: performance.now(),
    held,
    watched: false,
    hung: false,
    startDeadline: undefined,
  }
  worker.on('message', (message: unknown) => {
    if (isWorkerMessage(message)) events.message(record, message)
  })
  worker.on('error', error => events.error(record, error))
  const { threadId } = worker
  worker.on('exit', code => {
    releaseLocksOf(setup.memory, threadId)
    events.exit(record, code)
    exit.resolve()
  })
  return record
}
