import { threadId } from 'node:worker_threads'
import { createApp, type Logger } from '../../index.js'
import { brokerAdapter } from './broker-adapter.js'

const logger: Logger = {
  info: (details, message) => process.stderr.write(`info ${message} ${JSON.stringify(details)}\n`),
  warn: (details, message) => process.stderr.write(`warn ${message} ${JSON.stringify(details)}\n`),
  error: (details, message) => process.stderr.write(`error ${message} ${String(Reflect.get(details, 'err'))}\n`),
}

export default function buildApp() {
  const app = createApp({ logger, pubsub: brokerAdapter(Number(process.env.UHTTP_BROKER_PORT)) })
  return app
    .get('/thread', c => c.text(String(threadId)))
    .ws(
      '/chat/:topic',
      async (c, next) => {
        c.set('topic', c.req.param('topic'))
        await next()
      },
      {
        open: socket => {
          socket.subscribe(String(socket.data.topic))
          socket.send(`thread ${threadId}`)
        },
        message: (socket, message) => {
          socket.publish(String(socket.data.topic), message)
        },
      },
    )
}
