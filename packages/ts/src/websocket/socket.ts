import type { WebSocket } from 'uWebSockets.js'
import {
  MAX_APPLICATION_CLOSE_CODE,
  MAX_WEBSOCKET_CLOSE_REASON_BYTES,
  MIN_APPLICATION_CLOSE_CODE,
  WEBSOCKET_CLOSE_CODES,
  WEBSOCKET_NORMAL_CLOSE_CODE,
} from '../constants.js'
import { UhttpError } from '../errors.js'
import { checkedMessage, checkedTopic, type Hub } from './hub.js'
import type { SendOptions, SendStatus, ServerWebSocket } from './types.js'

const DROPPED: SendStatus = 2

/**
 * The package stores the {@link NativeSocket} of a client under this key of the user data that it
 * hands to uWebSockets.js, which copies the key onto its socket object.
 *
 * @internal
 */
export const SOCKET_STATE: unique symbol = Symbol('uhttp.socket')

/**
 * Returns the {@link NativeSocket} that the package stored on a socket of uWebSockets.js.
 *
 * @param ws - uWebSockets.js passes the socket to one of its handlers.
 * @returns The function returns `undefined` for a socket without one.
 * @internal
 */
export function socketOf(ws: WebSocket<unknown>): NativeSocket | undefined {
  const state: unknown = Reflect.get(ws, SOCKET_STATE)
  return state instanceof NativeSocket ? state : undefined
}

function checkedCloseCode(code: unknown): number {
  const sendable =
    typeof code === 'number' &&
    Number.isInteger(code) &&
    (WEBSOCKET_CLOSE_CODES.includes(code) || (code >= MIN_APPLICATION_CLOSE_CODE && code <= MAX_APPLICATION_CLOSE_CODE))
  if (!sendable) {
    throw new UhttpError(
      'INVALID_WEBSOCKET',
      `Close a WebSocket with a code that RFC 6455 lets a server send, such as 1000 or a code from ${MIN_APPLICATION_CLOSE_CODE} to ${MAX_APPLICATION_CLOSE_CODE}, and your code passed ${String(code)}.`,
    )
  }
  return code
}

function checkedReason(reason: unknown): string {
  if (typeof reason !== 'string' || Buffer.byteLength(reason) > MAX_WEBSOCKET_CLOSE_REASON_BYTES) {
    throw new UhttpError(
      'INVALID_WEBSOCKET',
      `Pass the close reason of a WebSocket as a string of at most ${MAX_WEBSOCKET_CLOSE_REASON_BYTES} bytes.`,
    )
  }
  return reason
}

function sendStatusOf(status: number): SendStatus {
  return status === 0 || status === 1 ? status : DROPPED
}

/**
 * The package hands every handler of a WebSocket route this object, which calls uWebSockets.js
 * while the socket stays open. Once the socket has closed, `send` returns 2, `subscribe` and
 * `unsubscribe` return `false`, `end` does nothing, and `publish` still reaches every subscriber.
 *
 * @internal
 */
export class NativeSocket implements ServerWebSocket {
  /** The chain stored these values during the upgrade. */
  readonly data: Record<string, unknown>
  readonly #hub: Hub
  #ws: WebSocket<unknown> | undefined
  #subscribed = false

  /**
   * Creates the socket of one client before the upgrade.
   *
   * @param data - The package passes the values that the chain stored during the upgrade.
   * @param hub - The package passes the hub of the thread, through which the socket publishes.
   */
  constructor(data: Record<string, unknown>, hub: Hub) {
    this.data = data
    this.#hub = hub
  }

  /**
   * Connects the object to the socket of uWebSockets.js once it opens.
   *
   * @param ws - uWebSockets.js passes the socket to its `open` handler.
   */
  attach(ws: WebSocket<unknown>): void {
    this.#ws = ws
  }

  /** Records that the socket has closed, after which every method does nothing. */
  detach(): void {
    this.#ws = undefined
  }

  /**
   * Sends a message to this client while the socket stays open.
   *
   * @param message - Your code passes the message.
   * @param options - Your code can choose a binary or a text message and ask for compression.
   * @returns The method returns the status from uWebSockets.js, or 2 once the socket has closed.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for a message of the wrong type.
   */
  send(message: string | Uint8Array | ArrayBuffer, options?: SendOptions): SendStatus {
    const payload = checkedMessage(message)
    const ws = this.#ws
    if (ws === undefined) return DROPPED
    return sendStatusOf(ws.send(payload, options?.binary ?? typeof payload !== 'string', options?.compress === true))
  }

  /**
   * Subscribes this socket to a topic while the socket stays open.
   *
   * @param topic - Your code passes the topic.
   * @returns The method returns `false` once the socket has closed, and `true` otherwise.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for a topic that is not a string.
   */
  subscribe(topic: string): boolean {
    const name = checkedTopic(topic)
    const ws = this.#ws
    if (ws === undefined) return false
    this.#subscribed = true
    ws.subscribe(name)
    return true
  }

  /**
   * Removes this socket from the subscribers of a topic while the socket stays open.
   *
   * @param topic - Your code passes the topic.
   * @returns The method returns `true` when the socket was a subscriber, and `false` once it has closed.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for a topic that is not a string.
   */
  unsubscribe(topic: string): boolean {
    const name = checkedTopic(topic)
    const ws = this.#ws
    if (ws === undefined) return false
    return ws.unsubscribe(name)
  }

  /**
   * Publishes a message through the hub, which leaves out this socket while it stays open and
   * subscribed.
   *
   * @param topic - Your code passes the topic.
   * @param message - Your code passes the message.
   * @param options - Your code can choose a binary or a text message and ask for compression.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for a topic or a message of the wrong type.
   */
  publish(topic: string, message: string | Uint8Array | ArrayBuffer, options?: SendOptions): void {
    const ws = this.#ws
    this.#hub.publish(topic, message, options, ws !== undefined && this.#subscribed ? ws : undefined)
  }

  /**
   * Closes the socket with a close frame, and does nothing once the socket has closed.
   *
   * @param code - Your code passes a close code that RFC 6455 lets a server send, or leaves it out for 1000.
   * @param reason - Your code passes a reason of up to 123 bytes, or leaves it out.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for any other code or a longer reason.
   */
  end(code: number = WEBSOCKET_NORMAL_CLOSE_CODE, reason = ''): void {
    const checkedCode = checkedCloseCode(code)
    const checkedText = checkedReason(reason)
    const ws = this.#ws
    if (ws === undefined) return
    this.#ws = undefined
    ws.end(checkedCode, checkedText)
  }

  /**
   * Returns the number of bytes that wait for the client to read.
   *
   * @returns The method returns 0 once the socket has closed.
   */
  getBufferedAmount(): number {
    return this.#ws?.getBufferedAmount() ?? 0
  }
}
