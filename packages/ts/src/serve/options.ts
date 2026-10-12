import { App } from '../app.js'
import {
  DEFAULT_CRASH_LIMIT,
  DEFAULT_CRASH_WINDOW_MS,
  DEFAULT_THREADS,
  DEFAULT_WATCHDOG_MS,
  MAX_CRASH_WINDOW_MS,
  MAX_PORT,
  MAX_THREADS,
  MAX_WATCHDOG_MS,
  MIN_CRASH_LIMIT,
  MIN_CRASH_WINDOW_MS,
  MIN_PORT,
  MIN_WORKER_HEAP_MB,
} from '../constants.js'
import { UhttpError } from '../errors.js'
import { checkedWholeNumber } from '../limits.js'
import type { Logger } from '../types.js'
import type { ListenAddress } from './listen.js'

/**
 * You pass these options to {@link serve} to choose the app, the address, and the worker threads.
 */
export interface ServeOptions {
  /**
   * You pass the app from {@link createApp}, or the URL of a module whose default export is the
   * app or a function that returns the app or a promise of it. With `threads`, you pass the URL,
   * such as `new URL('./app.js', import.meta.url)`, because each worker imports the module to build
   * its own app.
   */
  app: App | URL
  /**
   * The port must be a whole number from 0 to 65535, and with port 0 the operating system
   * assigns a free port. You pass either a port or a Unix socket path.
   */
  port?: number
  /**
   * The server listens on this address, such as `127.0.0.1`, and it listens on every interface
   * when you leave the address out.
   */
  host?: string
  /** The server listens on this Unix socket path in place of a port, on the main thread alone. */
  path?: string
  /**
   * The server serves requests on this many worker threads, which share the port. With 0, which is
   * the default, the main thread serves every request.
   */
  threads?: number
  /** Each worker thread can hold at most this many megabytes in its main heap, which is the default heap limit of Node.js when you leave it out. */
  workerHeapMb?: number
  /** The server exits with an error once workers crash this many times within `crashWindowMs`, which is 5 by default. */
  crashLimit?: number
  /** The server counts worker crashes within a window of this many milliseconds, which is 10 seconds by default. */
  crashWindowMs?: number
  /**
   * The server exits with an error when a worker fails to answer the main thread for this many
   * milliseconds, which is 30 seconds by default, and 0 switches the watchdog off.
   */
  watchdogMs?: number
  /**
   * The main thread writes each crash, each hang, and each exit with an error to this logger, and it
   * writes them to the console when you leave it out.
   */
  logger?: Logger
}

/**
 * The package checks the options of {@link serve} into this form.
 *
 * @internal
 */
export interface CheckedServeOptions {
  /** You passed this app or the URL of its module. */
  readonly app: App | URL
  /** The server listens on this address. */
  readonly address: ListenAddress
  /** The server serves requests on this many worker threads, or on the main thread at 0. */
  readonly threads: number
  /** Each worker can hold this many megabytes in its main heap, or the default of Node.js when this is `undefined`. */
  readonly workerHeapMb: number | undefined
  /** The server exits with an error once workers crash this many times within the window. */
  readonly crashLimit: number
  /** The server counts crashes within a window of this many milliseconds. */
  readonly crashWindowMs: number
  /** A worker has this many milliseconds to answer the main thread, and 0 switches the watchdog off. */
  readonly watchdogMs: number
  /** The main thread writes its events to this logger. */
  readonly logger: Logger
}

const consoleLogger: Logger = {
  info: (details, message) => console.info(message, details),
  warn: (details, message) => console.warn(message, details),
  error: (details, message) => console.error(message, details),
}

function invalid(message: string): UhttpError {
  return new UhttpError('INVALID_SERVE_OPTIONS', message)
}

function wholeNumberIn(value: unknown, name: string, fallback: number, low: number, high: number): number {
  if (value === undefined) return fallback
  return checkedWholeNumber(value, 'INVALID_SERVE_OPTIONS', name, low, high)
}

function checkedHeap(heap: unknown): number {
  return checkedWholeNumber(heap, 'INVALID_SERVE_OPTIONS', 'workerHeapMb', MIN_WORKER_HEAP_MB, Number.MAX_SAFE_INTEGER)
}

function checkedLogger(logger: Logger | undefined): Logger {
  if (logger === undefined) return consoleLogger
  const value: unknown = logger
  const complete =
    typeof value === 'object' &&
    value !== null &&
    ['info', 'warn', 'error'].every(level => typeof Reflect.get(value, level) === 'function')
  if (!complete) throw invalid('Pass a logger with info, warn, and error methods.')
  return logger
}

function checkedAddress(options: ServeOptions, threads: number): ListenAddress {
  const { port, host, path } = options
  if (path !== undefined) {
    if (typeof path !== 'string' || path === '') throw invalid('Set path to the file path of a Unix socket.')
    if (port !== undefined || host !== undefined) throw invalid('Pass either a Unix socket path or a port and a host.')
    if (threads > 0) throw invalid('Leave out threads when the server listens on a Unix socket path.')
    return { port: undefined, host: undefined, path }
  }
  if (port === undefined) throw invalid('Pass the port or the Unix socket path for the server to listen on.')
  if (host !== undefined && typeof host !== 'string') throw invalid('Set host to an address such as 127.0.0.1.')
  return { port: wholeNumberIn(port, 'the port', MIN_PORT, MIN_PORT, MAX_PORT), host, path: undefined }
}

/**
 * Returns the options of {@link serve} after checking each one and the way that they combine.
 *
 * @param options - You pass the options of the server.
 * @returns The function returns the options with every default filled in.
 * @throws {@link UhttpError} with the code `INVALID_SERVE_OPTIONS` when an option has the wrong type
 * or lies outside its range, when `threads` comes with an app object or a Unix socket path, or when
 * the options name neither a port nor a path.
 * @internal
 */
export function checkedServeOptions(options: ServeOptions): CheckedServeOptions {
  const { app } = options
  if (!(app instanceof App) && !(app instanceof URL)) {
    throw invalid('Pass the app from createApp(), or the URL of a module that exports it, as the app option.')
  }
  const threads = wholeNumberIn(options.threads, 'threads', DEFAULT_THREADS, 0, MAX_THREADS)
  if (threads > 0 && app instanceof App) {
    throw invalid('With threads, pass the URL of the app module, because each worker builds its own app from it.')
  }
  const heap = options.workerHeapMb
  if (heap !== undefined && threads === 0) throw invalid('Set workerHeapMb together with threads alone.')
  return {
    app,
    address: checkedAddress(options, threads),
    threads,
    workerHeapMb: heap === undefined ? undefined : checkedHeap(heap),
    crashLimit: wholeNumberIn(
      options.crashLimit,
      'crashLimit',
      DEFAULT_CRASH_LIMIT,
      MIN_CRASH_LIMIT,
      Number.MAX_SAFE_INTEGER,
    ),
    crashWindowMs: wholeNumberIn(
      options.crashWindowMs,
      'crashWindowMs',
      DEFAULT_CRASH_WINDOW_MS,
      MIN_CRASH_WINDOW_MS,
      MAX_CRASH_WINDOW_MS,
    ),
    watchdogMs: wholeNumberIn(options.watchdogMs, 'watchdogMs', DEFAULT_WATCHDOG_MS, 0, MAX_WATCHDOG_MS),
    logger: checkedLogger(options.logger),
  }
}
