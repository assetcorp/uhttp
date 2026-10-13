import type { Middleware, RouteOptions } from '../types.js'

/**
 * `send` returns the status that uWebSockets.js reports. The status is 1 when uWebSockets.js has
 * sent the message, and 0 when uWebSockets.js has queued the message in the buffer of the socket,
 * which it sends as the client reads. The status is 2 when uWebSockets.js has dropped the message,
 * because the buffer has passed the backpressure limit of the route or because the socket has
 * closed.
 */
export type SendStatus = 0 | 1 | 2

/**
 * You can pass these options to {@link ServerWebSocket.send} and {@link ServerWebSocket.publish}.
 */
export interface SendOptions {
  /**
   * When this is `true`, the package sends a binary message, and when it is `false`, the package
   * sends a text message. When you leave it out, the package sends a string as text and bytes as a
   * binary message.
   */
  readonly binary?: boolean
  /** When this is `true` and the route sets `compression`, the package compresses the message. */
  readonly compress?: boolean
}

/**
 * Every handler of a WebSocket route receives the socket of one client through this interface.
 *
 * @typeParam Data - You declare the shape of the values that your middleware stores during the upgrade.
 */
export interface ServerWebSocket<Data extends object = Record<string, unknown>> {
  /**
   * This object has the values that your middleware stored with {@link Context.set} during the
   * upgrade. Your handlers can read and change the values for as long as the socket is open, and
   * they can read them in the `close` handler too.
   */
  readonly data: Data
  /**
   * Sends a message to this client.
   *
   * @param message - The package sends a string as text and bytes as a binary message, unless you
   * set `binary` in the options.
   * @param options - You can choose a binary or a text message and ask for compression here.
   * @returns The method returns the {@link SendStatus} that uWebSockets.js reports, so that your
   * code can detect a dropped message.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` when the message is neither a
   * string nor bytes.
   */
  send(message: string | Uint8Array | ArrayBuffer, options?: SendOptions): SendStatus
  /**
   * Subscribes this socket to a topic, so that the package delivers to it every message that your
   * code publishes on the topic.
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
   * Sends a message to every other subscriber of a topic on every worker thread. When the app has a
   * pub/sub adapter, the package also passes the message to the adapter for the subscribers on
   * other servers. The package leaves this socket out, even when it subscribes to the topic.
   *
   * @param topic - You pass the name of the topic.
   * @param message - The package sends a string as text and bytes as a binary message, unless you
   * set `binary` in the options.
   * @param options - You can choose a binary or a text message and ask for compression here.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` when the topic is not a string or
   * the message is neither a string nor bytes.
   */
  publish(topic: string, message: string | Uint8Array | ArrayBuffer, options?: SendOptions): void
  /**
   * Closes the socket with a close frame, which uWebSockets.js sends after the messages that are
   * already in the buffer of the socket. The package then calls the `close` handler of the route.
   *
   * @param code - Pass a code that RFC 6455 lets a server send, such as 1000 or a code from 3000 to
   * 4999. The code is 1000 when you leave it out.
   * @param reason - The reason can be up to 123 bytes of UTF-8.
   * @throws {@link UhttpError} with the code `INVALID_WEBSOCKET` for any other code or a longer
   * reason.
   */
  end(code?: number, reason?: string): void
  /**
   * Returns the number of bytes in the buffer of the socket that uWebSockets.js has yet to send to
   * the client.
   *
   * @returns The method returns 0 once the socket has closed.
   */
  getBufferedAmount(): number
}

/**
 * You pass this object last to {@link Group.ws}, with the handlers and the limits of the route.
 *
 * @typeParam Data - You declare the shape of the values that your middleware stores during the upgrade.
 */
export interface WebSocketRoute<Data extends object = Record<string, unknown>> {
  /**
   * When you pass this list, the package accepts an upgrade only from these origins, such as
   * `https://app.example.com`. When you leave the list out, the package accepts an origin whose
   * host and port match the `Host` header of the request. The package always refuses the `null`
   * origin, and it accepts an upgrade without an `Origin` header.
   */
  readonly origins?: readonly string[]
  /**
   * uWebSockets.js drops the connection of a client that sends a message longer than this many
   * bytes, which is 16 KiB by default.
   */
  readonly maxMessageBytes?: number
  /**
   * uWebSockets.js closes a socket when the client sends nothing for this many milliseconds, which
   * is 2 minutes by default. Between 4 and 16 seconds before that point, uWebSockets.js sends a
   * ping, so that a client which answers pings keeps the socket open. The time must be from 8 to
   * 960 seconds, and the package rounds it up to the next second.
   */
  readonly idleTimeoutMs?: number
  /**
   * uWebSockets.js closes a socket once the socket has been open for this many milliseconds. The
   * package rounds the time up to the next minute, and the time can be at most 239 minutes. With
   * 0, which is the default, the package sets no limit on the lifetime of a socket.
   */
  readonly maxLifetimeMs?: number
  /**
   * uWebSockets.js drops each message that your code sends to a socket with more than this many
   * bytes in its buffer, which is 64 KiB by default. The buffer of a slow client therefore stays
   * close to this size.
   */
  readonly maxBackpressureBytes?: number
  /**
   * When this is `true`, uWebSockets.js closes a socket once it drops a message for backpressure,
   * and the package calls the `close` handler with 1006.
   */
  readonly closeOnBackpressureLimit?: boolean
  /**
   * When this is `true`, the package offers permessage-deflate to the client. Every socket on the
   * thread shares one compressor and one decompressor of uWebSockets.js.
   */
  readonly compression?: boolean
  /**
   * The package calls this handler once the socket opens.
   *
   * @param socket - The package passes the socket of the client.
   */
  readonly open?: (socket: ServerWebSocket<Data>) => void | Promise<void>
  /**
   * The package calls this handler for each message from the client. Because the package copies
   * every message before the call, your handler can await anything and then use the message.
   *
   * @param socket - The package passes the socket of the client.
   * @param message - The package passes a text message as a string and a binary message as bytes.
   */
  readonly message?: (socket: ServerWebSocket<Data>, message: string | Uint8Array) => void | Promise<void>
  /**
   * The package calls this handler each time uWebSockets.js has sent part of the bytes that were
   * queued on the socket, so that your handler can send more.
   *
   * @param socket - The package passes the socket of the client.
   */
  readonly drain?: (socket: ServerWebSocket<Data>) => void | Promise<void>
  /**
   * The package calls this handler once the socket has closed for any reason. From then on, `send`
   * drops every message, although your code can still read `data`.
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
 * @typeParam Data - You declare the shape of the values that your middleware stores during the upgrade.
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
   * When this is `true`, the package sends a binary message, and when it is `false`, the package
   * sends a text message. When you leave it out, the package sends a string as text and bytes as a
   * binary message.
   */
  readonly binary?: boolean
  /** When this is `true`, the package compresses the message for each socket whose route sets `compression`. */
  readonly compress?: boolean
}

/**
 * A pub/sub adapter passes published messages between servers, for example through Redis, so that
 * the package can deliver a message that your code publishes on one server to the subscribers on
 * another server. The package passes the adapter each message as bytes that include an ID of the
 * process that published it. When the adapter delivers a message back to that same process, the
 * package drops the message.
 */
export interface PubSubAdapter {
  /**
   * The package calls this method once on each thread that serves the app, when the server starts.
   *
   * @param deliver - Call this function with each message from another server. Pass it the topic
   * and the bytes that the other server passed to its adapter, unchanged.
   * @returns The method returns nothing, or a promise that settles once the adapter can deliver
   * messages.
   */
  start(deliver: (topic: string, payload: Uint8Array) => void): void | Promise<void>
  /**
   * The package calls this method when the first socket on a thread subscribes to a topic, so that
   * the adapter can listen for messages on the topic.
   *
   * @param topic - The package passes the name of the topic.
   * @returns The method returns nothing, or a promise that settles once the adapter listens.
   */
  subscribe(topic: string): void | Promise<void>
  /**
   * The package calls this method when the last socket on a thread unsubscribes from a topic or
   * closes.
   *
   * @param topic - The package passes the name of the topic.
   * @returns The method returns nothing, or a promise that settles once the adapter stops listening.
   */
  unsubscribe(topic: string): void | Promise<void>
  /**
   * The package calls this method for each message that your code publishes on this thread.
   *
   * @param topic - The package passes the name of the topic.
   * @param payload - The package passes the message as bytes. Pass the bytes unchanged to the
   * `deliver` function on every other server.
   * @returns The method returns nothing, or a promise that settles once the adapter has sent the message.
   */
  publish(topic: string, payload: Uint8Array): void | Promise<void>
  /**
   * The package calls this method once on each thread, when the server closes.
   *
   * @returns The method returns nothing, or a promise that settles once the adapter has closed.
   */
  close(): void | Promise<void>
}
