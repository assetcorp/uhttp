import { createServer, type Server, type Socket } from 'node:net'
import { afterEach } from 'vitest'

export interface BrokerEvent {
  client: number
  op: 'subscribe' | 'unsubscribe' | 'publish'
  topic: string
}

interface BrokerClient {
  readonly id: number
  readonly socket: Socket
  readonly topics: Set<string>
}

export interface Broker {
  readonly port: number
  readonly events: BrokerEvent[]
  inject(topic: string, payload: Uint8Array): void
  subscribers(topic: string): number
}

const servers = new Set<Server>()
const brokerSockets = new Set<Socket>()

afterEach(() => {
  for (const socket of brokerSockets) socket.destroy()
  for (const server of servers) server.close()
  brokerSockets.clear()
  servers.clear()
})

function frame(topic: string, payload: Uint8Array): string {
  return `${JSON.stringify({ op: 'message', topic, payload: Buffer.from(payload).toString('base64') })}\n`
}

export async function startBroker(): Promise<Broker> {
  const clients = new Set<BrokerClient>()
  const events: BrokerEvent[] = []
  let nextId = 1
  const deliver = (topic: string, payload: Uint8Array): void => {
    for (const client of clients) if (client.topics.has(topic)) client.socket.write(frame(topic, payload))
  }
  const server = createServer(socket => {
    const client: BrokerClient = { id: nextId++, socket, topics: new Set() }
    clients.add(client)
    brokerSockets.add(socket)
    let pending = ''
    socket.on('data', chunk => {
      pending += chunk.toString()
      let end = pending.indexOf('\n')
      while (end !== -1) {
        const line: unknown = JSON.parse(pending.slice(0, end))
        pending = pending.slice(end + 1)
        end = pending.indexOf('\n')
        if (typeof line !== 'object' || line === null) continue
        const op: unknown = Reflect.get(line, 'op')
        const topic: unknown = Reflect.get(line, 'topic')
        if (typeof topic !== 'string') continue
        if (op === 'subscribe') client.topics.add(topic)
        else if (op === 'unsubscribe') client.topics.delete(topic)
        else if (op !== 'publish') continue
        events.push({ client: client.id, op, topic })
        const payload: unknown = Reflect.get(line, 'payload')
        if (op === 'publish' && typeof payload === 'string') deliver(topic, Buffer.from(payload, 'base64'))
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => clients.delete(client))
  })
  servers.add(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The broker has no TCP port.')
  return {
    port: address.port,
    events,
    inject: deliver,
    subscribers(topic) {
      let count = 0
      for (const client of clients) if (client.topics.has(topic)) count++
      return count
    },
  }
}
