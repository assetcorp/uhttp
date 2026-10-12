import type { Middleware, RouteOptions } from '../types.js'

/**
 * `send` returns the status that uWebSockets.js reports: 1 when the socket sent the message, 0 when
 * the message waits in the buffer of the socket and goes out once the client reads, and 2 when the
 * socket dropped the message because its buffer passed the backpressure limit of the route or
 * because the socket has closed.
 */
export type SendStatus = 0 | 1 | 2

/**
 * You can pass these options to {@link ServerWebSocket.send} and {@link ServerWebSocket.publish}.
 */
export interface SendOptions {
  /**
   * When this is `true`, the package sends a binary message, and when it is `false`, a text
   * message. By default, it sends text for a string and binary for bytes.
   */
  readonly binary?: boolean
  /** When this is `true` and the route sets `compression`, the package compresses the message. */
  readonly compress?: boolean
}

/**
 * Every handler of a WebSocket route receives the socket of one client through this interface.
 *
 * @typeParam Data - You declare the shape of the values that the middleware stored during the upgrade.
 */
export interface ServerWebSocket<Data extends object = Record<string, unknown>> {
  /**
   * The middleware of the route stored these values with {@link Context.set} during the upgrade,
   * and your handlers can read and change them for as long as the socket stays open.
   */
  readonly data: Data
  /**
   * Sends a message to this client.
   *
   * @param message - The package sends a string as text and bytes as a binary message, unless the
   * options choose otherwise.
   * @param options - You can choose a binary or a text message and ask for compression here.
   * @returns The method returns the {@link SendStatus} that uWebSockets.js reports, so that your
   * code can detect a dropped message.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` when the message is neither a
   * string nor bytes.
   */
  send(message: string | Uint8Array | ArrayBuffer, options?: SendOptions): SendStatus
  /**
   * Subscribes this socket to a topic, so that it receives every message that the app publishes
   * on the topic.
   *
   * @param topic - You choose the name of the topic.
   * @returns The method returns `false` once the socket has closed, and `true` otherwise.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` when the topic is not a string.
   */
  subscribe(topic: string): boolean
  /**
   * Removes this socket from the subscribers of a topic.
   *
   * @param topic - You pass the name of the topic.
   * @returns The method returns `true` when the socket was a subscriber of the topic.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` when the topic is not a string.
   */
  unsubscribe(topic: string): boolean
  /**
   * Sends a message to every other subscriber of a topic, on every thread and, through a pub/sub
   * adapter, on every other server. This socket receives none of its own messages.
   *
   * @param topic - You pass the name of the topic.
   * @param message - The package sends a string as text and bytes as a binary message, unless the
   * options choose otherwise.
   * @param options - You can choose a binary or a text message and ask for compression here.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` when the topic is not a string or
   * the message is neither a string nor bytes.
   */
  publish(topic: string, message: string | Uint8Array | ArrayBuffer, options?: SendOptions): void
  /**
   * Closes the socket with a close frame, after the messages that it has already accepted. The
   * package then calls the `close` handler of the route.
   *
   * @param code - The code must be one that RFC 6455 lets an endpoint send, such as 1000 or a code
   * from 3000 to 4999, and it is 1000 when you leave it out.
   * @param reason - The reason can take up to 123 bytes of UTF-8.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for any other code or a longer
   * reason.
   */
  end(code?: number, reason?: string): void
  /**
   * Returns the number of bytes that wait in the buffer of the socket for the client to read.
   *
   * @returns The method returns 0 once the socket has closed.
   */
  getBufferedAmount(): number
}

/**
 * You pass this object last to {@link Group.ws}, with the handlers and the limits of the route.
 *
 * @typeParam Data - You declare the shape of the values that the middleware stored during the upgrade.
 */
export interface WebSocketRoute<Data extends object = Record<string, unknown>> {
  /**
   * The package accepts an upgrade from a browser page on one of these origins alone, such as
   * `https://app.example.com`. When you leave the list out, it accepts the origin whose host is the
   * `Host` of the request. It always refuses the `null` origin.
   */
  readonly origins?: readonly string[]
  /**
   * The package closes a socket whose client sends a longer message than this many bytes, which is
   * 16 KiB by default.
   */
  readonly maxMessageBytes?: number
  /**
   * uWebSockets.js closes a socket after this many milliseconds without a message, which is 2
   * minutes by default. The time must be from 8 to 960 seconds, and uWebSockets.js rounds it up to
   * the next second.
   */
  readonly idleTimeoutMs?: number
  /**
   * uWebSockets.js closes a socket after it has stayed open for this many milliseconds, rounded up
   * to the next minute, and the limit can be at most 239 minutes. With 0, which is the default, a
   * socket has no limit.
   */
  readonly maxLifetimeMs?: number
  /**
   * The package stops sending to a socket that has more than this many bytes waiting for the
   * client, which is 64 KiB by default, so that a slow client holds bounded memory.
   */
  readonly maxBackpressureBytes?: number
  /** When this is `true`, the package closes a socket once it drops a message for backpressure. */
  readonly closeOnBackpressureLimit?: boolean
  /**
   * When this is `true`, the package offers permessage-deflate to the client with the shared
   * compressor of uWebSockets.js, which keeps no memory per socket.
   */
  readonly compression?: boolean
  /**
   * The package calls this handler once the socket opens.
   *
   * @param socket - The package passes the socket of the client.
   */
  readonly open?: (socket: ServerWebSocket<Data>) => void | Promise<void>
  /**
   * The package calls this handler for each message from the client. It copies every message
   * before the call, so your handler can await anything before it reads the message.
   *
   * @param socket - The package passes the socket of the client.
   * @param message - The package passes a text message as a string and a binary message as bytes.
   */
  readonly message?: (socket: ServerWebSocket<Data>, message: string | Uint8Array) => void | Promise<void>
  /**
   * The package calls this handler once the client has read enough of the buffer of a socket that
   * passed its backpressure limit.
   *
   * @param socket - The package passes the socket of the client.
   */
  readonly drain?: (socket: ServerWebSocket<Data>) => void | Promise<void>
  /**
   * The package calls this handler once the socket has closed, for whatever reason. The socket
   * sends nothing from then on, while its `data` stays readable.
   *
   * @param socket - The package passes the socket of the client.
   * @param code - The package passes the close code, which is 1006 when the connection closed
   * without a close frame.
   * @param reason - The package passes the close reason, which is empty when the client sent none.
   */
  readonly close?: (socket: ServerWebSocket<Data>, code: number, reason: string) => void | Promise<void>
}

/**
 * You pass a WebSocket route any middleware for that route alone and any {@link RouteOptions}
 * object, and you pass the {@link WebSocketRoute} last.
 *
 * @typeParam Data - You declare the shape of the values that the middleware stored during the upgrade.
 */
export type WebSocketArguments<Data extends object = Record<string, unknown>> = readonly [
  ...stack: (Middleware | RouteOptions)[],
  route: WebSocketRoute<Data>,
]

/**
 * You can pass these options to {@link App.publish}.
 */
export interface PublishOptions {
  /**
   * When this is `true`, the package sends a binary message, and when it is `false`, a text
   * message. By default, it sends text for a string and binary for bytes.
   */
  readonly binary?: boolean
  /** When this is `true`, the package compresses the message for each socket whose route sets `compression`. */
  readonly compress?: boolean
}

/**
 * A pub/sub adapter carries published messages between servers, such as through Redis, so that a
 * subscriber on one machine receives a message that a socket on another machine publishes. The
 * package hands the adapter each message as bytes that also identify the process that published
 * it, and it drops a message that comes back to that same process.
 */
export interface PubSubAdapter {
  /**
   * The package calls this method once, when the server starts on a thread.
   *
   * @param deliver - The adapter calls this function with each message that arrives from another
   * server, passing the topic and the bytes that the other server handed to its adapter.
   * @returns The method returns nothing, or a promise that settles once the adapter is ready.
   */
  start(deliver: (topic: string, payload: Uint8Array) => void): void | Promise<void>
  /**
   * The package calls this method when a topic gains its first subscriber on a thread, so that the
   * adapter can listen for messages on the topic.
   *
   * @param topic - The package passes the name of the topic.
   * @returns The method returns nothing, or a promise that settles once the adapter listens.
   */
  subscribe(topic: string): void | Promise<void>
  /**
   * The package calls this method when a topic loses its last subscriber on a thread.
   *
   * @param topic - The package passes the name of the topic.
   * @returns The method returns nothing, or a promise that settles once the adapter stops listening.
   */
  unsubscribe(topic: string): void | Promise<void>
  /**
   * The package calls this method for each message that code on this thread publishes.
   *
   * @param topic - The package passes the name of the topic.
   * @param payload - The package passes the message as bytes, which the adapter hands unchanged to
   * the `deliver` function of every other server.
   * @returns The method returns nothing, or a promise that settles once the adapter has sent the message.
   */
  publish(topic: string, payload: Uint8Array): void | Promise<void>
  /**
   * The package calls this method once, when the server closes.
   *
   * @returns The method returns nothing, or a promise that settles once the adapter has closed.
   */
  close(): void | Promise<void>
}
