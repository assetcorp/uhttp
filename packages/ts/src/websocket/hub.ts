import type { TemplatedApp, WebSocket } from 'uWebSockets.js'
import { PUBSUB_BINARY_FLAG, PUBSUB_COMPRESS_FLAG, PUBSUB_ENVELOPE_VERSION, PUBSUB_ORIGIN_BYTES } from '../constants.js'
import { UhttpError } from '../errors.js'
import type { Logger } from '../types.js'
import type { PublishOptions, PubSubAdapter } from './types.js'

const VERSION_INDEX = 0
const FLAGS_INDEX = 1
const ORIGIN_INDEX = 2
const ENVELOPE_HEADER_BYTES = ORIGIN_INDEX + PUBSUB_ORIGIN_BYTES
const ADAPTER_FAILED_MESSAGE = 'The pub/sub adapter failed.'
const ADAPTER_MESSAGE_DROPPED =
  'The package dropped a message from the pub/sub adapter, because it could not parse the message.'

/**
 * The hub of a worker thread passes topic changes and published messages to the other workers
 * through this interface.
 *
 * @internal
 */
export interface PeerRelay {
  /**
   * Posts a message to every other worker when the first socket on this thread subscribes to a
   * topic, or when the last one leaves the topic.
   *
   * @param topic - The hub passes the name of the topic.
   * @param subscribed - The hub passes `true` for the first subscriber and `false` once the last one leaves.
   */
  announce(topic: string, subscribed: boolean): void
  /**
   * Sends a published message to every other worker with a subscriber on its topic.
   *
   * @param topic - The hub passes the name of the topic.
   * @param message - The hub passes the message as text or as bytes that no other view shares.
   * @param binary - The hub passes `true` for a binary message.
   * @param compress - The hub passes `true` when the code that published the message asked for compression.
   */
  forward(topic: string, message: string | Uint8Array, binary: boolean, compress: boolean): void
}

/**
 * Returns a topic once the function has checked that it is a string.
 *
 * @param topic - Your code passes the topic.
 * @returns The function returns the topic unchanged.
 * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for anything other than a string.
 * @internal
 */
export function checkedTopic(topic: unknown): string {
  if (typeof topic !== 'string') {
    throw new UhttpError('INVALID_WEBSOCKET', `Pass the topic as a string, and your code passed ${typeof topic}.`)
  }
  return topic
}

/**
 * Returns a message as text or as bytes, once the function has checked its type.
 *
 * @param message - Your code passes the message.
 * @returns The function returns a string unchanged, and the bytes of an `ArrayBuffer` or a view
 * as a `Uint8Array`.
 * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for anything other than a string, an
 * `ArrayBuffer`, or a `Uint8Array`.
 * @internal
 */
export function checkedMessage(message: unknown): string | Uint8Array {
  if (typeof message === 'string' || message instanceof Uint8Array) return message
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  throw new UhttpError('INVALID_WEBSOCKET', 'Pass a WebSocket message as a string, an ArrayBuffer, or a Uint8Array.')
}

/**
 * Returns a copy of bytes in a buffer of their own, or the bytes unchanged when they already fill
 * their buffer, so that a structured clone copies the message alone.
 *
 * @param bytes - The package passes the bytes of a message.
 * @returns The function returns bytes that fill their whole buffer.
 * @internal
 */
export function ownedBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
}

function sameOrigin(payload: Uint8Array, origin: Uint8Array): boolean {
  for (let index = 0; index < PUBSUB_ORIGIN_BYTES; index++) {
    if (payload[index + ORIGIN_INDEX] !== origin[index]) return false
  }
  return true
}

/**
 * The hub of one thread publishes each message to the subscribers on the thread, to the other
 * workers through the relay, and to other servers through the pub/sub adapter.
 *
 * @internal
 */
export class Hub {
  /** A worker thread sets this relay to the other workers when it starts. The relay is `undefined` on a server without threads. */
  relay: PeerRelay | undefined
  #native: TemplatedApp
  readonly #appsByTopic = new Map<string, number>()
  readonly #origin: Uint8Array
  readonly #adapter: PubSubAdapter | undefined
  readonly #logger: Logger | undefined
  readonly #text = new TextDecoder('utf-8', { fatal: true })
  readonly #topics = new TextDecoder()
  readonly #utf8 = new TextEncoder()
  #closed = false

  /**
   * Creates the hub of one thread.
   *
   * @param native - The package passes the app of uWebSockets.js on this thread.
   * @param origin - The package passes the bytes that identify this process to the adapter.
   * @param adapter - The package passes the pub/sub adapter of the app, or `undefined`.
   * @param logger - The package passes the logger of the app, or `undefined`.
   */
  constructor(
    native: TemplatedApp,
    origin: Uint8Array,
    adapter: PubSubAdapter | undefined,
    logger: Logger | undefined,
  ) {
    this.#native = native
    this.#origin = origin
    this.#adapter = adapter
    this.#logger = logger
  }

  /**
   * Publishes through another app of uWebSockets.js from now on, which the package does once a
   * reload has replaced the app on this thread.
   *
   * @param native - The package passes the app of uWebSockets.js that serves from now on.
   */
  useNative(native: TemplatedApp): void {
    this.#native = native
  }

  /**
   * Publishes a message to every subscriber of a topic on this thread, on the other workers, and
   * through the adapter.
   *
   * @param topic - Your code passes the topic.
   * @param message - Your code passes the message.
   * @param options - Your code can choose a binary or a text message and ask for compression.
   * @param sender - The package passes the socket that publishes, so that uWebSockets.js leaves that
   * socket out. The package passes `undefined` for `app.publish()`, and for a socket that has never
   * subscribed to a topic.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` when the topic or the message has
   * the wrong type.
   */
  publish(topic: unknown, message: unknown, options: PublishOptions | undefined, sender?: WebSocket<unknown>): void {
    const name = checkedTopic(topic)
    const payload = checkedMessage(message)
    const binary = options?.binary ?? typeof payload !== 'string'
    const compress = options?.compress === true
    if (this.#closed) return
    if (sender === undefined) this.#native.publish(name, payload, binary, compress)
    else sender.publish(name, payload, binary, compress)
    this.relay?.forward(name, typeof payload === 'string' ? payload : ownedBytes(payload), binary, compress)
    const adapter = this.#adapter
    if (adapter !== undefined) this.#call(() => adapter.publish(name, this.#envelope(payload, binary, compress)))
  }

  /**
   * Publishes a message from another worker to the subscribers on this thread alone.
   *
   * @param topic - The relay passes the topic.
   * @param message - The relay passes the message.
   * @param binary - The relay passes `true` for a binary message.
   * @param compress - The relay passes `true` when the code that published the message asked for compression.
   */
  deliver(topic: string, message: string | Uint8Array, binary: boolean, compress: boolean): void {
    if (!this.#closed) this.#native.publish(topic, message, binary, compress)
  }

  /**
   * Calls the relay and the adapter when the first socket on this thread subscribes to a topic, or
   * when the last one leaves the topic, as uWebSockets.js reports each change. During a reload, two
   * apps of uWebSockets.js serve on the thread, so the hub counts the apps with subscribers to each
   * topic.
   *
   * @param topic - uWebSockets.js passes the topic as bytes.
   * @param newCount - uWebSockets.js passes the number of subscribers on its app after the change.
   * @param oldCount - uWebSockets.js passes the number of subscribers on its app before the change.
   */
  subscriptionChanged(topic: ArrayBuffer, newCount: number, oldCount: number): void {
    const first = oldCount === 0 && newCount > 0
    const last = newCount === 0 && oldCount > 0
    if ((!first && !last) || this.#closed) return
    const name = this.#topics.decode(topic)
    const apps = this.#appsByTopic.get(name) ?? 0
    const remaining = first ? apps + 1 : apps - 1
    if (remaining > 0) this.#appsByTopic.set(name, remaining)
    else this.#appsByTopic.delete(name)
    if (apps > 0 && remaining > 0) return
    this.relay?.announce(name, first)
    const adapter = this.#adapter
    if (adapter === undefined) return
    this.#call(() => (first ? adapter.subscribe(name) : adapter.unsubscribe(name)))
  }

  /**
   * Starts the adapter, which then delivers each message from another server to the subscribers
   * on this thread.
   *
   * @returns The promise settles once the adapter has started, and it never rejects.
   */
  async start(): Promise<void> {
    const adapter = this.#adapter
    if (adapter === undefined) return
    await this.#call(() => adapter.start((topic, payload) => this.#receive(topic, payload)))
  }

  /**
   * Stops every delivery to this thread and closes the adapter.
   *
   * @returns The promise settles once the adapter has closed, and it never rejects.
   */
  async close(): Promise<void> {
    this.#closed = true
    this.relay = undefined
    const adapter = this.#adapter
    if (adapter === undefined) return
    await this.#call(() => adapter.close())
  }

  #envelope(payload: string | Uint8Array, binary: boolean, compress: boolean): Uint8Array {
    const body = typeof payload === 'string' ? this.#utf8.encode(payload) : payload
    const envelope = new Uint8Array(ENVELOPE_HEADER_BYTES + body.byteLength)
    envelope[VERSION_INDEX] = PUBSUB_ENVELOPE_VERSION
    envelope[FLAGS_INDEX] = (binary ? PUBSUB_BINARY_FLAG : 0) | (compress ? PUBSUB_COMPRESS_FLAG : 0)
    envelope.set(this.#origin, ORIGIN_INDEX)
    envelope.set(body, ENVELOPE_HEADER_BYTES)
    return envelope
  }

  #receive(topic: unknown, payload: unknown): void {
    if (this.#closed) return
    if (
      typeof topic !== 'string' ||
      !(payload instanceof Uint8Array) ||
      payload.byteLength < ENVELOPE_HEADER_BYTES ||
      payload[VERSION_INDEX] !== PUBSUB_ENVELOPE_VERSION
    ) {
      this.#warn(ADAPTER_MESSAGE_DROPPED)
      return
    }
    if (sameOrigin(payload, this.#origin)) return
    const flags = payload[FLAGS_INDEX] ?? 0
    const binary = (flags & PUBSUB_BINARY_FLAG) !== 0
    const body = payload.subarray(ENVELOPE_HEADER_BYTES)
    let message: string | Uint8Array = body
    if (!binary) {
      try {
        message = this.#text.decode(body)
      } catch {
        this.#warn(ADAPTER_MESSAGE_DROPPED)
        return
      }
    }
    this.#native.publish(topic, message, binary, (flags & PUBSUB_COMPRESS_FLAG) !== 0)
  }

  #warn(message: string): void {
    try {
      this.#logger?.warn({}, message)
    } catch {
      return
    }
  }

  #fail(error: unknown): void {
    try {
      this.#logger?.error({ err: error }, ADAPTER_FAILED_MESSAGE)
    } catch {
      return
    }
  }

  #call(run: () => void | Promise<void>): Promise<void> | undefined {
    try {
      const result = run()
      if (result instanceof Promise) return result.catch(error => this.#fail(error))
    } catch (error) {
      this.#fail(error)
    }
    return undefined
  }
}
