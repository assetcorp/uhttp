import { connect, type Socket } from 'node:net'
import type { PubSubAdapter } from '../../index.js'

export function brokerAdapter(port: number): PubSubAdapter {
  let socket: Socket | undefined
  const send = (line: object): void => {
    socket?.write(`${JSON.stringify(line)}\n`)
  }
  return {
    start(deliver) {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const connection = connect({ port, host: '127.0.0.1' }, resolve)
      socket = connection
      connection.once('error', reject)
      let pending = ''
      connection.on('data', chunk => {
        pending += chunk.toString()
        let end = pending.indexOf('\n')
        while (end !== -1) {
          const line: unknown = JSON.parse(pending.slice(0, end))
          pending = pending.slice(end + 1)
          end = pending.indexOf('\n')
          if (typeof line !== 'object' || line === null) continue
          const topic: unknown = Reflect.get(line, 'topic')
          const payload: unknown = Reflect.get(line, 'payload')
          if (typeof topic === 'string' && typeof payload === 'string') {
            deliver(topic, new Uint8Array(Buffer.from(payload, 'base64')))
          }
        }
      })
      return promise
    },
    subscribe(topic) {
      send({ op: 'subscribe', topic })
    },
    unsubscribe(topic) {
      send({ op: 'unsubscribe', topic })
    },
    publish(topic, payload) {
      send({ op: 'publish', topic, payload: Buffer.from(payload).toString('base64') })
    },
    close() {
      socket?.end()
    },
  }
}
