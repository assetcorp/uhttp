import type { Worker } from 'node:worker_threads'
import { EXIT_HOOK_WAIT_MS } from '../constants.js'
import type { MainMessage } from './messages.js'

/**
 * The exit hook reads these facts about each worker thread.
 *
 * @internal
 */
export interface ExitingWorker {
  /** The main thread posts the `exit` message to this worker. */
  readonly worker: Worker
  /** The worker sets the first element of this shared array to 1 once it has closed its connections. */
  readonly exitFlag: Int32Array
  /** This is `true` once the worker has exited. */
  readonly gone: boolean
  /** This is `true` once the watchdog has found that the worker fails to answer. */
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
 * Adds a listener for the `exit` event of the process, which asks every worker that has neither
 * exited nor hung to close its connections and then blocks the main thread until each one has done
 * so, for up to {@link EXIT_HOOK_WAIT_MS} in total. Node.js aborts the process when it exits while
 * a worker still holds the sockets of uWebSockets.js, and a worker can still close them while the
 * main thread waits, because each thread has its own event loop.
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
