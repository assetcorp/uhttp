import type { AppDescriptor } from 'uWebSockets.js'
import { MessagePort } from 'node:worker_threads'
import { MAX_ERROR_CAUSE_DEPTH } from '../constants.js'
import { CLOSING, type LeavingMode, RETIRING } from '../native/drain.js'
import type { CheckedTls } from '../serve/tls-options.js'

/**
 * The main thread passes each worker these values when it starts the worker.
 *
 * @internal
 */
export interface WorkerSetup {
  /** The worker imports the app module from this URL. */
  readonly module: string
  /** These bytes identify the process to the pub/sub adapter. */
  readonly origin: Uint8Array
  /** The worker serves HTTPS with these certificates, or plain HTTP when this is `undefined`. */
  readonly tls: CheckedTls | undefined
  /**
   * The worker sets the first element of this shared array to 1 after it closes its connections
   * and before it exits, so that the main thread can wait for the worker in its exit hook.
   */
  readonly exitFlag: Int32Array
}

/**
 * A worker posts these messages to the main thread.
 *
 * @internal
 */
export type WorkerMessage =
  | { readonly type: 'ready'; readonly descriptor: AppDescriptor; readonly secure: boolean }
  | { readonly type: 'failed'; readonly error: SerializedError }
  | { readonly type: 'crashed'; readonly error: SerializedError }
  | { readonly type: 'pong' }

/**
 * The main thread posts these messages to a worker.
 *
 * @internal
 */
export type MainMessage =
  | { readonly type: 'ping' }
  | { readonly type: 'drain'; readonly mode: LeavingMode; readonly graceMs: number }
  | { readonly type: 'exit' }
  | { readonly type: 'peer'; readonly id: number; readonly port: MessagePort }
  | { readonly type: 'peer-gone'; readonly id: number }

/**
 * Two workers post these messages to each other through the channel between them.
 *
 * @internal
 */
export type PeerMessage =
  | { readonly type: 'topics'; readonly topics: readonly string[] }
  | { readonly type: 'subscribe'; readonly topic: string }
  | { readonly type: 'unsubscribe'; readonly topic: string }
  | {
      readonly type: 'publish'
      readonly topic: string
      readonly message: string | Uint8Array
      readonly binary: boolean
      readonly compress: boolean
    }

/**
 * A worker posts an error to the main thread in this form, because a structured clone of an error
 * keeps only some of its properties and drops its `code`.
 *
 * @internal
 */
export interface SerializedError {
  /** The error had this name, such as `UhttpError`. */
  readonly name: string
  /** The error had this message. */
  readonly message: string
  /** The error had this stack trace, when it had one. */
  readonly stack: string | undefined
  /** The error had this code, when it had one. */
  readonly code: string | undefined
  /** The error wrapped this error, when it wrapped one. */
  readonly cause: SerializedError | undefined
}

/**
 * Returns an error as a plain object that a structured clone copies whole, with its chain of causes.
 *
 * @param error - The worker passes the error that it caught.
 * @param depth - The function passes the depth of the cause that it serialises.
 * @returns The function returns the serialised error.
 * @internal
 */
export function serializedError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error), stack: undefined, code: undefined, cause: undefined }
  }
  const code: unknown = Reflect.get(error, 'code')
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: typeof code === 'string' ? code : undefined,
    cause:
      error.cause === undefined || depth >= MAX_ERROR_CAUSE_DEPTH ? undefined : serializedError(error.cause, depth + 1),
  }
}

/**
 * Returns an `Error` with the name, the message, the stack, the code, and the causes of a
 * serialised error.
 *
 * @param value - The main thread passes the error that a worker posted.
 * @returns The function returns a new error.
 * @internal
 */
export function revivedError(value: unknown): Error {
  if (typeof value !== 'object' || value === null) return new Error(String(value))
  const message: unknown = Reflect.get(value, 'message')
  const cause: unknown = Reflect.get(value, 'cause')
  const error = new Error(String(message), cause === undefined ? undefined : { cause: revivedError(cause) })
  const name: unknown = Reflect.get(value, 'name')
  const stack: unknown = Reflect.get(value, 'stack')
  const code: unknown = Reflect.get(value, 'code')
  if (typeof name === 'string') error.name = name
  if (typeof stack === 'string') error.stack = stack
  if (typeof code === 'string') Object.defineProperty(error, 'code', { value: code, enumerable: true })
  return error
}

function typeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined
}

/**
 * Returns `true` when a value that the main thread received from a worker has the shape of a
 * {@link WorkerMessage}.
 *
 * @param value - The main thread passes the message.
 * @returns The function returns `false` for any other value.
 * @internal
 */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  const type = typeOf(value)
  return type === 'ready' || type === 'failed' || type === 'crashed' || type === 'pong'
}

/**
 * Returns `true` when a value that a worker received from the main thread has the shape of a
 * {@link MainMessage}.
 *
 * @param value - The worker passes the message.
 * @returns The function returns `false` for any other value.
 * @internal
 */
export function isMainMessage(value: unknown): value is MainMessage {
  const type = typeOf(value)
  if (type === 'ping' || type === 'exit') return true
  if (typeof value !== 'object' || value === null) return false
  if (type === 'drain') {
    const mode: unknown = Reflect.get(value, 'mode')
    return (mode === RETIRING || mode === CLOSING) && typeof Reflect.get(value, 'graceMs') === 'number'
  }
  if (type !== 'peer' && type !== 'peer-gone') return false
  if (typeof Reflect.get(value, 'id') !== 'number') return false
  return type === 'peer-gone' || Reflect.get(value, 'port') instanceof MessagePort
}

/**
 * Returns `true` when a value that a worker received from another worker has the shape of a
 * {@link PeerMessage}.
 *
 * @param value - The worker passes the message.
 * @returns The function returns `false` for any other value.
 * @internal
 */
export function isPeerMessage(value: unknown): value is PeerMessage {
  const type = typeOf(value)
  if (typeof value !== 'object' || value === null) return false
  if (type === 'topics') {
    const topics: unknown = Reflect.get(value, 'topics')
    return Array.isArray(topics) && topics.every(topic => typeof topic === 'string')
  }
  if (typeof Reflect.get(value, 'topic') !== 'string') return false
  if (type === 'subscribe' || type === 'unsubscribe') return true
  if (type !== 'publish') return false
  const message: unknown = Reflect.get(value, 'message')
  return (
    (typeof message === 'string' || message instanceof Uint8Array) &&
    typeof Reflect.get(value, 'binary') === 'boolean' &&
    typeof Reflect.get(value, 'compress') === 'boolean'
  )
}
