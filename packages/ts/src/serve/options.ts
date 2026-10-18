import { App } from '../app.js'
import {
  DEFAULT_CRASH_LIMIT,
  DEFAULT_CRASH_WINDOW_MS,
  DEFAULT_GRACE_PERIOD_MS,
  DEFAULT_SOCKET_MODE,
  DEFAULT_THREADS,
  DEFAULT_WATCHDOG_MS,
  DEFAULT_WORKER_START_TIMEOUT_MS,
  MAX_CRASH_WINDOW_MS,
  MAX_GRACE_PERIOD_MS,
  MAX_PORT,
  MAX_SOCKET_MODE,
  MAX_THREADS,
  MAX_WATCHDOG_MS,
  MAX_WORKER_START_TIMEOUT_MS,
  MIN_CRASH_LIMIT,
  MIN_CRASH_WINDOW_MS,
  MIN_PORT,
  MIN_WORKER_HEAP_MB,
} from '../constants.js'
import { UhttpError } from '../errors.js'
import { checkedWholeNumber } from '../limits.js'
import type { Logger } from '../types.js'
import type { ListenAddress } from './listen.js'
import { type CheckedTls, checkedTls, type TlsOptions } from './tls-options.js'

/**
 * You pass these options to {@link serve} to choose the app, the address, the certificates, and the
 * worker threads.
 */
export interface ServeOptions {
  /**
   * You pass the app from {@link createApp}, or the URL of a module whose default export is the
   * app or a function that returns the app or a promise of it. With `threads`, pass the URL, such
   * as `new URL('./app.js', import.meta.url)`, because each worker imports the module and builds
   * its own app from it.
   */
  app: App | URL
  /**
   * The port must be a whole number from 0 to 65535. With port 0, the operating system assigns a
   * free port. Pass either a port or a Unix socket path.
   */
  port?: number
  /**
   * The server listens on this address, such as `127.0.0.1`. When you leave the address out, the
   * server listens on every interface.
   */
  host?: string
  /** The server listens on this Unix socket path in place of a port. Only the main thread serves the requests on that socket. */
  path?: string
  /**
   * By default, the server binds its port exclusively, so a second server on the same port fails
   * with `LISTEN_FAILED`. With `true`, the operating system lets every server that sets
   * `reusePort` share the port. Pass it with a port above 0 alone.
   */
  reusePort?: boolean
  /**
   * Once the server listens, the package sets the mode of the Unix socket file to this mode, such
   * as `0o660` to let the group of the process connect. The mode is `0o600` by default, so that only
   * the user who owns the process can connect. Pass it with a path alone.
   */
  socketMode?: number
  /**
   * `server.close()` waits this many milliseconds for the requests in progress and the WebSockets
   * before it closes the connections that are left. `server.reload()` waits as long before it
   * closes the old connections that are left. The grace period is 10 seconds by default.
   */
  gracePeriodMs?: number
  /**
   * With this option, the server serves HTTPS with the key and the certificate in these files. It
   * sends the certificate of a hostname under `hostnames` to a client that sends that hostname.
   */
  tls?: TlsOptions
  /**
   * The package starts this many worker threads, which serve the requests from one port. With 0,
   * which is the default, the main thread serves every request.
   */
  threads?: number
  /** The package limits the main heap of each worker thread to this many megabytes. When you leave it out, each worker has the default heap limit of Node.js. */
  workerHeapMb?: number
  /** The server exits with an error once workers crash this many times within `crashWindowMs`. The limit is 5 by default. */
  crashLimit?: number
  /** The server counts the crashes of the workers within a window of this many milliseconds, which is 10 seconds by default. */
  crashWindowMs?: number
  /**
   * The server exits with an error when a worker sends no reply to a ping from the main thread for
   * this many milliseconds, which is 30 seconds by default. Set it to 0 to switch the watchdog off.
   */
  watchdogMs?: number
  /**
   * The main thread stops a worker thread that takes longer than this many milliseconds to build
   * its app. The limit is 90 seconds by default. When a worker of the first start takes too long,
   * `serve()` rejects with `APP_START_FAILED`. When a worker of a reload takes too long,
   * `server.reload()` rejects with the same code while the old workers go on serving. When the
   * replacement for a crashed worker takes too long, the main thread counts that start as a crash
   * towards `crashLimit`. Set it to 0 to let a worker take as long as it needs.
   */
  workerStartTimeoutMs?: number
  /**
   * The main thread writes each crash, each hang, and each exit with an error to this logger. When
   * you leave it out, the main thread writes them to the console.
   */
  logger?: Logger
}

/**
 * The package stores the options of {@link serve} in this form once it checks them.
 *
 * @internal
 */
export interface CheckedServeOptions {
  /** You pass this app or the URL of its module. */
  readonly app: App | URL
  /** The server listens on this address. */
  readonly address: ListenAddress
  /** The package starts this many worker threads. At 0, the main thread serves every request. */
  readonly threads: number
  /** The package limits the main heap of each worker to this many megabytes. Node.js applies its default limit when this is `undefined`. */
  readonly workerHeapMb: number | undefined
  /** The server exits with an error once workers crash this many times within the window. */
  readonly crashLimit: number
  /** The server counts crashes within a window of this many milliseconds. */
  readonly crashWindowMs: number
  /** A worker has this many milliseconds to reply to a ping from the main thread. A value of 0 switches the watchdog off. */
  readonly watchdogMs: number
  /** A worker has this many milliseconds to build its app. A value of 0 switches the limit off. */
  readonly workerStartTimeoutMs: number
  /** The main thread writes its events to this logger. */
  readonly logger: Logger
  /** During a close or a reload, the server waits this many milliseconds before it closes the connections that are left. */
  readonly gracePeriodMs: number
  /** The server serves HTTPS with these certificates, or plain HTTP when this is `undefined`. */
  readonly tls: CheckedTls | undefined
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

function checkedReusePort(reusePort: unknown, port: number): boolean {
  if (reusePort === undefined) return false
  if (typeof reusePort !== 'boolean') throw invalid('Set reusePort to true or false.')
  if (reusePort && port === 0) {
    throw invalid('Pass reusePort with a port above 0, because the operating system assigns a new port for port 0.')
  }
  return reusePort
}

function checkedAddress(options: ServeOptions, threads: number): ListenAddress {
  const { port, host, path, reusePort, socketMode } = options
  if (path !== undefined) {
    if (typeof path !== 'string' || path === '') throw invalid('Set path to the file path of a Unix socket.')
    if (port !== undefined || host !== undefined) throw invalid('Pass either a Unix socket path or a port and a host.')
    if (threads > 0) throw invalid('Leave out threads when the server listens on a Unix socket path.')
    if (reusePort !== undefined) throw invalid('Leave out reusePort when the server listens on a Unix socket path.')
    return {
      port: undefined,
      host: undefined,
      path,
      reusePort: false,
      socketMode: wholeNumberIn(socketMode, 'socketMode', DEFAULT_SOCKET_MODE, 0, MAX_SOCKET_MODE),
    }
  }
  if (port === undefined) throw invalid('Pass the port or the Unix socket path for the server to listen on.')
  if (host !== undefined && typeof host !== 'string') throw invalid('Set host to an address such as 127.0.0.1.')
  if (socketMode !== undefined) throw invalid('Pass socketMode with a Unix socket path alone.')
  const checkedPort = wholeNumberIn(port, 'the port', MIN_PORT, MIN_PORT, MAX_PORT)
  return {
    port: checkedPort,
    host,
    path: undefined,
    reusePort: checkedReusePort(reusePort, checkedPort),
    socketMode: DEFAULT_SOCKET_MODE,
  }
}

/**
 * Returns the options of {@link serve} after the function checks each option on its own and
 * together with the others.
 *
 * @param options - The package passes the options that you gave to {@link serve}.
 * @returns The function returns the options with every default filled in.
 * @throws {@link UhttpError} with the code `INVALID_SERVE_OPTIONS` when an option has the wrong type
 * or a value outside its range, when you pass options that the package can't use together, such
 * as `threads` with an app object, or when you pass neither a port nor a path.
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
  for (const [name, value] of [
    ['workerHeapMb', heap],
    ['workerStartTimeoutMs', options.workerStartTimeoutMs],
  ] as const) {
    if (value !== undefined && threads === 0) throw invalid(`Set threads whenever you set ${name}.`)
  }
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
    workerStartTimeoutMs: wholeNumberIn(
      options.workerStartTimeoutMs,
      'workerStartTimeoutMs',
      DEFAULT_WORKER_START_TIMEOUT_MS,
      0,
      MAX_WORKER_START_TIMEOUT_MS,
    ),
    logger: checkedLogger(options.logger),
    gracePeriodMs: wholeNumberIn(
      options.gracePeriodMs,
      'gracePeriodMs',
      DEFAULT_GRACE_PERIOD_MS,
      0,
      MAX_GRACE_PERIOD_MS,
    ),
    tls: checkedTls(options.tls),
  }
}
