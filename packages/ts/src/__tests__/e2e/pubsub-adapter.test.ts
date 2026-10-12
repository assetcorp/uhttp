import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp, type PubSubAdapter, serve } from '../../index.js'
import { type Broker, startBroker } from '../helpers/broker.js'
import { startHost, waitFor } from '../helpers/child.js'
import { track } from '../helpers/server.js'
import { openSocket, type TestSocket } from '../helpers/websocket.js'

const ENVELOPE_VERSION = 1
const BINARY_FLAG = 1
const ORIGIN_BYTES = 16
const DROPPED_WARNING =
  'The package dropped a message from the pub/sub adapter, because it could not parse the message.'

function foreignEnvelope(flags: number, body: Uint8Array): Uint8Array {
  return new Uint8Array([ENVELOPE_VERSION, flags, ...randomBytes(ORIGIN_BYTES), ...body])
}

function startAdapterHost(broker: Broker, threads: number) {
  return startHost({
    UHTTP_FIXTURE_APP: './adapter-app.js',
    UHTTP_BROKER_PORT: String(broker.port),
    UHTTP_THREADS: String(threads),
  })
}

async function socketOnNewThread(port: number, topic: string, seen: Set<string>): Promise<TestSocket> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const socket = await openSocket(port, `/chat/${topic}`)
    const thread = String(await socket.nextMessage())
    if (!seen.has(thread)) {
      seen.add(thread)
      return socket
    }
    socket.close()
  }
  throw new Error('Every socket opened on a thread that another socket already holds.')
}

function topicEvents(broker: Broker, topic: string): string[] {
  return broker.events.filter(event => event.topic === topic && event.op !== 'publish').map(event => event.op)
}

describe('a pub/sub adapter shared by several servers', () => {
  it('delivers a publish once to every subscriber on every server and worker, and never back to the sender', async () => {
    const broker = await startBroker()
    const threaded = await startAdapterHost(broker, 2)
    const single = await startAdapterHost(broker, 0)
    const seen = new Set<string>()
    const sender = await socketOnNewThread(threaded.port, 'room', seen)
    const sibling = await socketOnNewThread(threaded.port, 'room', seen)
    const remote = await openSocket(single.port, '/chat/room')
    await remote.nextMessage()
    await waitFor(() => (broker.subscribers('room') === 3 ? true : undefined), 2_000, 'Three adapter subscriptions')

    sender.send('hello everyone')
    sender.send(new Uint8Array([1, 2, 3]))

    expect(await sibling.nextMessages(2)).toEqual(['hello everyone', new Uint8Array([1, 2, 3])])
    expect(await remote.nextMessages(2)).toEqual(['hello everyone', new Uint8Array([1, 2, 3])])
    expect(await sender.silence(200)).toEqual([])
    expect(await sibling.silence(0)).toEqual([])
    expect(await remote.silence(0)).toEqual([])
  })

  it('subscribes through the adapter for the first subscriber of a topic and unsubscribes after the last one leaves', async () => {
    const broker = await startBroker()
    const host = await startAdapterHost(broker, 0)
    const first = await openSocket(host.port, '/chat/news')
    const second = await openSocket(host.port, '/chat/news')
    await Promise.all([first.nextMessage(), second.nextMessage()])
    await waitFor(() => (broker.subscribers('news') === 1 ? true : undefined), 2_000, 'The adapter subscription')

    first.close()
    await first.closed
    await second.silence(200)
    expect(topicEvents(broker, 'news')).toEqual(['subscribe'])

    second.close()
    await second.closed
    await waitFor(() => (broker.subscribers('news') === 0 ? true : undefined), 2_000, 'The adapter unsubscription')
    expect(topicEvents(broker, 'news')).toEqual(['subscribe', 'unsubscribe'])
  })

  it('logs a warning and drops a message from the adapter that the package cannot parse, and delivers a message from another server', async () => {
    const broker = await startBroker()
    const host = await startAdapterHost(broker, 0)
    const listener = await openSocket(host.port, '/chat/room')
    await listener.nextMessage()
    await waitFor(() => (broker.subscribers('room') === 1 ? true : undefined), 2_000, 'The adapter subscription')

    broker.inject('room', new Uint8Array([9, 9]))
    broker.inject('room', new Uint8Array([ENVELOPE_VERSION + 1, 0, ...new Uint8Array(ORIGIN_BYTES), 104, 105]))
    broker.inject('room', foreignEnvelope(0, new Uint8Array([0xff, 0xfe])))
    broker.inject('room', foreignEnvelope(0, new TextEncoder().encode('from elsewhere')))
    broker.inject('room', foreignEnvelope(BINARY_FLAG, new Uint8Array([7, 8])))

    expect(await listener.nextMessages(2)).toEqual(['from elsewhere', new Uint8Array([7, 8])])
    expect(await listener.silence(100)).toEqual([])
    expect(host.output().split(DROPPED_WARNING)).toHaveLength(4)
  })
})

function failingAdapter(): PubSubAdapter {
  return {
    start: () => undefined,
    subscribe: () => {
      throw new Error('The adapter refuses to subscribe.')
    },
    unsubscribe: () => Promise.reject(new Error('The adapter refuses to unsubscribe.')),
    publish: () => Promise.reject(new Error('The adapter refuses to publish.')),
    close: () => undefined,
  }
}

describe('a pub/sub adapter that fails', () => {
  it('logs each failure and keeps delivering to the subscribers on the server', async () => {
    const failures: string[] = []
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (details: object, message: string) => {
        const error: unknown = Reflect.get(details, 'err')
        failures.push(`${message} ${error instanceof Error ? error.message : String(error)}`)
      },
    }
    const app = createApp({ logger, pubsub: failingAdapter() }).ws('/chat', {
      open: socket => {
        socket.subscribe('room')
      },
      message: (socket, message) => {
        socket.publish('room', message)
      },
    })
    const server = track(await serve({ app, port: 0, host: '127.0.0.1' }))
    const sender = await openSocket(server.port, '/chat')
    const receiver = await openSocket(server.port, '/chat')

    sender.send('still delivered')

    expect(await receiver.nextMessage()).toBe('still delivered')
    receiver.close()
    await receiver.closed
    sender.close()
    await sender.closed
    await waitFor(() => (failures.length >= 3 ? true : undefined), 2_000, 'Three logged failures')
    expect(failures).toEqual(
      expect.arrayContaining([
        'The pub/sub adapter failed. The adapter refuses to subscribe.',
        'The pub/sub adapter failed. The adapter refuses to publish.',
        'The pub/sub adapter failed. The adapter refuses to unsubscribe.',
      ]),
    )
  })
})
