import { appendFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getHeapStatistics } from 'node:v8'
import { MessagePort, threadId } from 'node:worker_threads'
import { createApp } from '../../index.js'

const stateDirectory = process.env.UHTTP_FIXTURE_DIR
const SLOW_START_MS = 3_000
const CRASH_AFTER_START_MS = 200
let portMessages = 0
const postMessage = MessagePort.prototype.postMessage

MessagePort.prototype.postMessage = function countedPost(...args: Parameters<MessagePort['postMessage']>) {
  portMessages++
  return Reflect.apply(postMessage, this, args)
}

function record(event: string): void {
  if (stateDirectory !== undefined)
    appendFileSync(join(stateDirectory, 'starts'), `${Date.now()} ${threadId} ${event}\n`)
}

function blockForever(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

function claimed(name: string): boolean {
  if (stateDirectory === undefined) return false
  try {
    renameSync(join(stateDirectory, name), join(stateDirectory, `${name}.claimed`))
    return true
  } catch {
    return false
  }
}

export default async function buildApp() {
  if (stateDirectory !== undefined && existsSync(join(stateDirectory, 'fail-start'))) {
    record('fail')
    throw new Error('The fixture refuses to build its app.')
  }
  if (claimed('crash-after-start')) {
    setTimeout(() => {
      throw new Error('The fixture crashed on purpose after it started.')
    }, CRASH_AFTER_START_MS)
  } else if (stateDirectory !== undefined && existsSync(join(stateDirectory, 'slow-start'))) {
    record('slow')
    await new Promise(resolve => setTimeout(resolve, SLOW_START_MS))
  }
  record('start')
  const app = createApp()
  app
    .get('/thread', c => c.text(String(threadId)))
    .get('/heap', c => c.text(String(getHeapStatistics().heap_size_limit)))
    .get('/allocate', c => {
      const hoard: number[][] = []
      setTimeout(() => {
        for (;;) hoard.push(new Array<number>(1_000_000).fill(hoard.length))
      }, 0)
      return c.text('allocating')
    })
    .get('/crash', c => {
      setTimeout(() => {
        throw new Error('The fixture crashed on purpose.')
      }, 0)
      return c.text('crashing')
    })
    .get('/reject', c => {
      setTimeout(() => {
        void Promise.reject(new Error('The fixture rejected on purpose.'))
      }, 0)
      return c.text('rejecting')
    })
    .get('/hang', c => {
      setTimeout(blockForever, 0)
      return c.text('hanging')
    })
    .post('/publish/:topic', c => {
      const before = portMessages
      app.publish(c.req.param('topic') ?? '', `from thread ${threadId}`)
      return c.text(String(portMessages - before))
    })
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
  return app
}
