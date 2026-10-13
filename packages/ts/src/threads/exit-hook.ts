import type { Worker } from 'node:worker_threads'
import { EXIT_HOOK_WAIT_MS } from '../constants.js'
import type { MainMessage } from './messages.js'

/**
 * The exit hook uses these values of each worker thread.
 *
 * @internal
 */
export interface ExitingWorker {
  /** The main thread posts the `exit` message to this worker. */
  readonly worker: Worker
  /** The worker sets the first element of this shared array to 1 once it closes its connections. */
  readonly exitFlag: Int32Array
  /** This is `true` once the worker exits. */
  readonly gone: boolean
  /** This is `true` once the main thread marks the worker as hung. */
  readonly hung: boolean
}

function waitForWorkers(workers: Iterable<ExitingWorker>): void {
  const waiting = [...workers].filter(worker => !worker.gone && !worker.hung)
  for (const { worker } of waiting) worker.postMessage({ type: 'exit' } satisfies MainMessage)
  const deadline = performance.now() + EXIT_HOOK_WAIT_MS
  for (const { exitFlag } of waiting) {
    const left = deadline - performance.now()
    if (left <= 0) return
    Atomics.wait(exitFlag, 0, 0, left)
  }
}

/**
 * Adds a listener for the `exit` event of the process. The listener posts the `exit` message to
 * every worker that is alive and not hung, and then it blocks the main thread until each of those
 * workers closes its connections, for up to {@link EXIT_HOOK_WAIT_MS} in total. Node.js aborts the
 * process when it exits while a worker has sockets of uWebSockets.js open. A worker can close its
 * sockets while the main thread blocks, because each thread has its own event loop.
 *
 * @param workers - The package passes a function that returns the current workers.
 * @returns The function returns a function that removes the listener.
 * @internal
 */
export function addExitHook(workers: () => Iterable<ExitingWorker>): () => void {
  const listener = (): void => waitForWorkers(workers())
  process.on('exit', listener)
  return () => {
    process.off('exit', listener)
  }
}
