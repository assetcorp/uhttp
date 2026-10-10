import { DEFAULT_SSE_HEARTBEAT_MS, SSE_HEARTBEAT_COMMENT } from './constants.js'
import { UhttpError } from './errors.js'
import { type HeaderRecord, headerLinesOf } from './headers.js'
import { createReply, type Reply, type ResponseStream } from './reply.js'

const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream'
const LINE_BREAK = /\r\n|\r|\n/
const CR_OR_LF = /[\r\n]/
const NUL = '\u0000'

/**
 * You send one server-sent event in this shape, and the package leaves out each field that you
 * leave out.
 */
export interface ServerSentEvent {
  /** The package splits the data on CR, LF, and CRLF, and it sends each line as its own `data` field. */
  readonly data?: string
  /** The browser dispatches the event under this name, which must contain no CR and no LF. */
  readonly event?: string
  /** The browser stores this ID as the last event ID, and the ID must contain no CR, no LF, and no NUL. */
  readonly id?: string
  /** The browser waits this many milliseconds before it reconnects, and the time must be a whole number of zero or more. */
  readonly retry?: number
}

/**
 * Your event producer sends server-sent events through this object.
 */
export interface EventStream {
  /**
   * Sends one event. The promise that the method returns stays pending while the client reads
   * slowly.
   *
   * @param event - The package checks every field of the event before it sends anything.
   * @returns The promise resolves to `true` once the package has written the event to the socket,
   * or to `false` once the client has gone.
   * @throws {@link UhttpError} with the code `INVALID_EVENT` when the name contains CR or LF, when the
   * ID contains CR, LF, or NUL, or when the retry time is not a whole number of zero or more.
   */
  send(event: ServerSentEvent): Promise<boolean>
  /**
   * Adds a function that the package calls once, when the client goes or the stream ends.
   *
   * @param listener - The package calls this function once.
   */
  onClose(listener: () => void): void
  /** This is `true` once the client has gone or the stream has ended. */
  readonly closed: boolean
}

/**
 * An event producer sends server-sent events and returns once the stream is complete.
 *
 * @param events - The package passes the event stream that your producer sends to.
 * @returns The producer returns nothing, or a promise that settles once the stream is complete.
 */
export type EventStreamProducer = (events: EventStream) => void | Promise<void>

/**
 * You pass these options to {@link Context.sse}.
 */
export interface EventStreamOptions {
  /** When you leave out the status, the package sends 200. */
  readonly status?: number
  /** The package sends these headers with the stream, and it sends `cache-control: no-cache` unless they set another value. */
  readonly headers?: HeaderRecord
  /**
   * The package sends a heartbeat comment at this interval in milliseconds, which is 30,000 by
   * default. nginx and an AWS Application Load Balancer both close a connection after 60 seconds
   * without data under their default settings. With 0, the package sends no heartbeat.
   */
  readonly heartbeatMs?: number
}

function invalid(message: string): UhttpError {
  return new UhttpError('INVALID_EVENT', message)
}

function formatEvent({ data, event, id, retry }: ServerSentEvent): string {
  let text = ''
  if (event !== undefined) {
    if (CR_OR_LF.test(event)) throw invalid('The name of a server-sent event must contain no CR and no LF.')
    text += `event: ${event}\n`
  }
  if (id !== undefined) {
    if (CR_OR_LF.test(id) || id.includes(NUL)) {
      throw invalid('The ID of a server-sent event must contain no CR, no LF, and no NUL.')
    }
    text += `id: ${id}\n`
  }
  if (retry !== undefined) {
    if (!Number.isSafeInteger(retry) || retry < 0) {
      throw invalid(
        `The retry time of a server-sent event must be a whole number of zero or more, and your code passed ${retry}.`,
      )
    }
    text += `retry: ${retry}\n`
  }
  if (data !== undefined) {
    for (const line of data.split(LINE_BREAK)) text += `data: ${line}\n`
  }
  return `${text}\n`
}

function heartbeatInterval(heartbeatMs: number): number {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0) {
    throw new UhttpError(
      'INVALID_STREAM',
      `The heartbeat interval must be a whole number of milliseconds of zero or more, and your code passed ${heartbeatMs}.`,
    )
  }
  return heartbeatMs
}

function startHeartbeat(stream: ResponseStream, intervalMs: number): () => void {
  if (intervalMs === 0) return () => undefined
  let waiting = false
  const timer = setInterval(() => {
    if (waiting || stream.closed) return
    waiting = true
    stream.write(SSE_HEARTBEAT_COMMENT).then(
      () => {
        waiting = false
      },
      () => clearInterval(timer),
    )
  }, intervalMs)
  timer.unref()
  const stop = (): void => clearInterval(timer)
  stream.onClose(stop)
  return stop
}

/**
 * Returns the streamed reply behind {@link Context.sse}. The heartbeat stops when the client goes,
 * when the stream ends, and when the producer returns.
 *
 * @param produce - The handler passes its event producer.
 * @param options - The handler passes the status, the headers, and the heartbeat interval.
 * @returns The function returns a streamed reply with the content type `text/event-stream`.
 * @throws {@link UhttpError} with the code `INVALID_STREAM` when the heartbeat interval is not a
 * whole number of milliseconds of zero or more.
 * @internal
 */
export function eventStreamReply(produce: EventStreamProducer, options: EventStreamOptions): Reply {
  const { status = 200, headers, heartbeatMs = DEFAULT_SSE_HEARTBEAT_MS } = options
  const intervalMs = heartbeatInterval(heartbeatMs)
  const lines = headerLinesOf(headers) ?? new Map<string, string[]>()
  if (!lines.has('cache-control')) lines.set('cache-control', ['no-cache'])
  lines.set('content-type', [EVENT_STREAM_CONTENT_TYPE])
  return createReply(status, EVENT_STREAM_CONTENT_TYPE, null, lines, {
    length: undefined,
    produce: async stream => {
      const stopHeartbeat = startHeartbeat(stream, intervalMs)
      try {
        await produce({
          send: event => stream.write(formatEvent(event)),
          onClose: listener => stream.onClose(listener),
          get closed() {
            return stream.closed
          },
        })
      } finally {
        stopHeartbeat()
      }
    },
  })
}
