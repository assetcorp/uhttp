import type { WebSocket, WebSocketBehavior } from 'uWebSockets.js'
import type { CompiledApp, CompiledWebSocket } from '../compile.js'
import { WEBSOCKET_HANDLER_ERROR_CODE } from '../constants.js'
import type { Logger } from '../types.js'
import type { Hub } from './hub.js'
import { type NativeSocket, socketOf } from './socket.js'
import { upgradeHandler } from './upgrade.js'

const HANDLER_FAILED_MESSAGE = 'A WebSocket handler failed.'

/**
 * The package reads the compression flags of uWebSockets.js through this interface, so that the
 * module never loads uWebSockets.js itself.
 *
 * @internal
 */
export interface CompressionFlags {
  /** uWebSockets.js turns compression off with this value. */
  readonly DISABLED: number
  /** uWebSockets.js compresses with one compressor that every socket shares under this flag. */
  readonly SHARED_COMPRESSOR: number
  /** uWebSockets.js decompresses with one decompressor that every socket shares under this flag. */
  readonly SHARED_DECOMPRESSOR: number
}

function logFailure(logger: Logger | undefined, error: unknown, path: string, handler: string): void {
  try {
    logger?.error({ err: error, path, handler }, HANDLER_FAILED_MESSAGE)
  } catch {
    return
  }
}

function runHandler(
  logger: Logger | undefined,
  path: string,
  name: string,
  socket: NativeSocket,
  run: () => unknown,
): void {
  const fail = (error: unknown): void => {
    logFailure(logger, error, path, name)
    if (name !== 'close') socket.end(WEBSOCKET_HANDLER_ERROR_CODE)
  }
  try {
    const result = run()
    if (result instanceof Promise) result.catch(fail)
  } catch (error) {
    fail(error)
  }
}

/**
 * Returns the behaviour of one WebSocket route for uWebSockets.js, with its limits, its upgrade
 * handler, and the handlers that call the handlers of the route. The package copies each message
 * before it calls the `message` handler, and it passes text as a string and binary data as bytes.
 * When a handler throws or rejects, the package logs the error and closes the socket with 1011,
 * apart from the `close` handler, whose error it logs alone.
 *
 * @param flags - The package passes the compression flags of uWebSockets.js.
 * @param app - The package passes the compiled app.
 * @param compiled - The package passes the compiled WebSocket route.
 * @param hub - The package passes the hub of the thread.
 * @returns The function returns the behaviour to pass to `ws()` of uWebSockets.js.
 * @internal
 */
export function socketBehavior(
  flags: CompressionFlags,
  app: CompiledApp,
  compiled: CompiledWebSocket,
  hub: Hub,
): WebSocketBehavior<unknown> {
  const { route } = compiled
  const { logger } = app.runtime
  const path = compiled.upgrade.path
  const text = new TextDecoder()
  const { open, message, drain, close } = route
  return {
    maxPayloadLength: route.maxPayloadLength,
    idleTimeout: route.idleTimeout,
    maxLifetime: route.maxLifetime,
    maxBackpressure: route.maxBackpressure,
    closeOnBackpressureLimit: route.closeOnBackpressureLimit,
    compression: route.compression ? flags.SHARED_COMPRESSOR | flags.SHARED_DECOMPRESSOR : flags.DISABLED,
    sendPingsAutomatically: true,
    upgrade: upgradeHandler(app, compiled, hub),
    open: (ws: WebSocket<unknown>) => {
      const socket = socketOf(ws)
      if (socket === undefined) return
      socket.attach(ws)
      if (open !== undefined) runHandler(logger, path, 'open', socket, () => open(socket))
    },
    message: (ws: WebSocket<unknown>, data: ArrayBuffer, isBinary: boolean) => {
      const socket = socketOf(ws)
      if (socket === undefined || message === undefined) return
      const copied = isBinary ? new Uint8Array(data.slice(0)) : text.decode(data)
      runHandler(logger, path, 'message', socket, () => message(socket, copied))
    },
    drain: (ws: WebSocket<unknown>) => {
      const socket = socketOf(ws)
      if (socket === undefined || drain === undefined) return
      runHandler(logger, path, 'drain', socket, () => drain(socket))
    },
    close: (ws: WebSocket<unknown>, code: number, reason: ArrayBuffer) => {
      const socket = socketOf(ws)
      if (socket === undefined) return
      socket.detach()
      if (close === undefined) return
      const copied = text.decode(reason)
      runHandler(logger, path, 'close', socket, () => close(socket, code, copied))
    },
    subscription: (_ws: WebSocket<unknown>, topic: ArrayBuffer, newCount: number, oldCount: number) => {
      hub.subscriptionChanged(topic, newCount, oldCount)
    },
  }
}
