import { describe, expect, it } from 'vitest'
import { createApp, type ServerWebSocket } from '../../index.js'
import { memoryLogger, pause, start } from '../helpers/server.js'
import { openSocket } from '../helpers/websocket.js'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

describe('a WebSocket route on the network', () => {
  it('opens a socket whose handlers send text and bytes back, and reports the status of each send', async () => {
    const statuses: number[] = []
    const app = createApp().ws('/echo', {
      message: (socket, message) => {
        statuses.push(socket.send(message))
      },
    })
    const server = await start(app)
    const client = await openSocket(server.port, '/echo')

    client.send('hello')
    client.send(bytes(0, 1, 255))

    expect(await client.nextMessages(2)).toEqual(['hello', bytes(0, 1, 255)])
    expect(statuses).toEqual([1, 1])
  })

  it('copies each message, so that a handler can read it after an await while more messages arrive', async () => {
    const app = createApp().ws('/slow-echo', {
      message: async (socket, message) => {
        await pause(20)
        socket.send(message)
      },
    })
    const server = await start(app)
    const client = await openSocket(server.port, '/slow-echo')

    for (let index = 0; index < 20; index++) client.send(bytes(index, index, index))
    client.send('café ☕')

    const received = await client.nextMessages(21)
    expect(received.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => bytes(index, index, index)))
    expect(received[20]).toBe('café ☕')
  })

  it('copies the values that the middleware of an upgrade stored into the data of the socket, after an await in the middleware', async () => {
    const opened: unknown[] = []
    const app = createApp().ws(
      '/rooms/:room',
      { headers: ['authorization'] },
      async (c, next) => {
        await pause(5)
        c.set('room', c.req.param('room'))
        c.set('token', c.req.header('authorization') ?? 'none')
        await next()
      },
      {
        open: socket => {
          opened.push({ ...socket.data })
          socket.send(JSON.stringify(socket.data))
        },
      },
    )
    const server = await start(app)
    const client = await openSocket(server.port, '/rooms/lobby')

    expect(JSON.parse(String(await client.nextMessage()))).toEqual({ room: 'lobby', token: 'none' })
    expect(opened).toEqual([{ room: 'lobby', token: 'none' }])
  })

  it('delivers a publish to every subscriber of a topic, and leaves out the socket that publishes', async () => {
    const app = createApp().ws('/chat', {
      open: socket => {
        socket.subscribe('room')
      },
      message: (socket, message) => {
        socket.publish('room', message)
      },
    })
    const server = await start(app)
    const [alice, bob, carol] = await Promise.all([1, 2, 3].map(() => openSocket(server.port, '/chat')))
    if (alice === undefined || bob === undefined || carol === undefined) throw new Error('A socket failed to open.')

    alice.send('hi from alice')

    expect(await bob.nextMessage()).toBe('hi from alice')
    expect(await carol.nextMessage()).toBe('hi from alice')
    expect(await alice.silence(100)).toEqual([])
  })

  it('publishes from a socket that never subscribed, and from the app, to every subscriber', async () => {
    const app = createApp()
    app
      .ws('/listen', {
        open: socket => {
          socket.subscribe('news')
        },
      })
      .ws('/speak', {
        message: (socket, message) => {
          socket.publish('news', message)
        },
      })
      .post('/announce', c => {
        app.publish('news', 'from the app', { binary: true })
        return c.text('sent')
      })
    const server = await start(app)
    const listener = await openSocket(server.port, '/listen')
    const speaker = await openSocket(server.port, '/speak')

    speaker.send('from a speaker')
    expect(await listener.nextMessage()).toBe('from a speaker')
    await fetch(`http://127.0.0.1:${server.port}/announce`, { method: 'POST' })

    expect(await listener.nextMessage()).toEqual(new TextEncoder().encode('from the app'))
    expect(await speaker.silence(50)).toEqual([])
  })

  it('stops delivering a topic after unsubscribe, and reports whether the socket was a subscriber', async () => {
    const results: boolean[] = []
    const app = createApp()
    app
      .ws('/chat', {
        open: socket => {
          socket.subscribe('room')
        },
        message: socket => {
          results.push(socket.unsubscribe('room'), socket.unsubscribe('room'))
          socket.send('left')
        },
      })
      .post('/say', c => {
        app.publish('room', 'after leaving')
        return c.text('sent')
      })
    const server = await start(app)
    const client = await openSocket(server.port, '/chat')

    client.send('leave')
    expect(await client.nextMessage()).toBe('left')
    await fetch(`http://127.0.0.1:${server.port}/say`, { method: 'POST' })

    expect(await client.silence(100)).toEqual([])
    expect(results).toEqual([true, false])
  })

  it('closes with the code and reason that the server chose, and calls close with what the client sent', async () => {
    const closes: unknown[] = []
    const app = createApp().ws('/chat', {
      message: (socket, message) => {
        if (message === 'bye') socket.end(4000, 'see you')
      },
      close: (socket, code, reason) => {
        closes.push({
          code,
          reason,
          data: socket.data,
          send: socket.send('late'),
          buffered: socket.getBufferedAmount(),
        })
      },
    })
    const server = await start(app)
    const leaving = await openSocket(server.port, '/chat')
    const ended = await openSocket(server.port, '/chat')

    leaving.close(4001, 'going away now')
    ended.send('bye')

    expect(await ended.closed).toEqual({ code: 4000, reason: 'see you' })
    await leaving.closed
    await pause(20)
    expect(closes).toEqual(
      expect.arrayContaining([
        { code: 4001, reason: 'going away now', data: {}, send: 2, buffered: 0 },
        { code: 4000, reason: 'see you', data: {}, send: 2, buffered: 0 },
      ]),
    )
  })

  it('throws INVALID_WEBSOCKET for a close code or reason that RFC 6455 forbids, and for a message of the wrong type', async () => {
    const errors: string[] = []
    const attempt = (run: () => void): void => {
      try {
        run()
        errors.push('none')
      } catch (error) {
        errors.push((error as { code?: string }).code ?? 'unknown')
      }
    }
    const app = createApp().ws('/chat', {
      open: socket => {
        attempt(() => socket.end(1005))
        attempt(() => socket.end(1006))
        attempt(() => socket.end(2999))
        attempt(() => socket.end(5000))
        attempt(() => socket.end(1000, 'x'.repeat(124)))
        attempt(() => socket.end(1000, 'é'.repeat(62)))
        attempt(() => Reflect.apply(socket.send, socket, [42]))
        attempt(() => Reflect.apply(socket.subscribe, socket, [42]))
        attempt(() => Reflect.apply(socket.publish, socket, ['room', { text: 'hi' }]))
        socket.send(errors.join(','))
      },
    })
    const server = await start(app)
    const client = await openSocket(server.port, '/chat')

    expect(await client.nextMessage()).toBe(
      'INVALID_WEBSOCKET,INVALID_WEBSOCKET,INVALID_WEBSOCKET,INVALID_WEBSOCKET,INVALID_WEBSOCKET,INVALID_WEBSOCKET,INVALID_WEBSOCKET,INVALID_WEBSOCKET,INVALID_WEBSOCKET',
    )
  })

  it('closes the socket with 1011 and logs the error when a handler throws or rejects', async () => {
    const { entries, logger } = memoryLogger()
    const app = createApp({ logger }).ws('/chat', {
      message: async (_socket, message) => {
        if (message === 'reject') {
          await pause(1)
          throw new Error('rejected')
        }
        throw new Error('thrown')
      },
    })
    const server = await start(app)
    const thrown = await openSocket(server.port, '/chat')
    const rejected = await openSocket(server.port, '/chat')

    thrown.send('throw')
    rejected.send('reject')

    expect((await thrown.closed).code).toBe(1011)
    expect((await rejected.closed).code).toBe(1011)
    expect(entries.filter(entry => entry.level === 'error').map(entry => entry.details.handler)).toEqual([
      'message',
      'message',
    ])
  })

  it('drops the connection of a client that sends a message longer than maxMessageBytes', async () => {
    const received: number[] = []
    const closes: unknown[] = []
    const app = createApp().ws('/chat', {
      maxMessageBytes: 16,
      message: (_socket, message) => {
        received.push(message.length)
      },
      close: (_socket, code, reason) => {
        closes.push({ code, reason })
      },
    })
    const server = await start(app)
    const client = await openSocket(server.port, '/chat')

    client.send('x'.repeat(16))
    await pause(20)
    client.send('x'.repeat(17))

    expect((await client.closed).code).toBe(1006)
    expect(received).toEqual([16])
    expect(closes).toEqual([{ code: 1006, reason: 'Received too big message' }])
  })

  it('reports a close code from 1012 to 3999 that a client sends as 1006, as uWebSockets.js does', async () => {
    const closes: number[] = []
    const app = createApp().ws('/chat', {
      close: (_socket, code) => {
        closes.push(code)
      },
    })
    const server = await start(app)
    const client = await openSocket(server.port, '/chat')

    client.close(3001, 'registered code')
    await client.closed
    await pause(20)

    expect(closes).toEqual([1006])
  })

  it('offers permessage-deflate on a route with compression, and on no other route', async () => {
    const app = createApp()
      .ws('/compressed', {
        compression: true,
        message: (socket, message) => {
          socket.send(message, { compress: true })
        },
      })
      .ws('/plain', {})
    const server = await start(app)
    const compressed = await openSocket(server.port, '/compressed')
    const plain = await openSocket(server.port, '/plain')

    compressed.send('a'.repeat(2_000))

    expect(await compressed.nextMessage()).toBe('a'.repeat(2_000))
    expect(compressed.socket.extensions).toContain('permessage-deflate')
    expect(plain.socket.extensions).toBe('')
  })

  it('calls drain as uWebSockets.js sends a queued buffer, while send reports the backpressure', async () => {
    const statuses: number[] = []
    const drained = Promise.withResolvers<void>()
    const big = 'x'.repeat(64 * 1024)
    let flooded: ServerWebSocket | undefined
    const app = createApp().ws('/flood', {
      maxBackpressureBytes: 1024 * 1024,
      message: socket => {
        flooded = socket
        for (let index = 0; index < 64; index++) statuses.push(socket.send(big))
      },
      drain: () => drained.resolve(),
    })
    const server = await start(app)
    const client = await openSocket(server.port, '/flood')

    client.send('go')
    await drained.promise

    expect(statuses).toContain(0)
    expect(flooded?.getBufferedAmount()).toBeLessThan(1024 * 1024)
    await client.nextMessages(statuses.filter(status => status !== 2).length, 10_000)
  })

  it('closes the socket once send drops a message for backpressure, when the route sets closeOnBackpressureLimit', async () => {
    const statuses: number[] = []
    const closes: number[] = []
    const big = 'x'.repeat(64 * 1024)
    const app = createApp().ws('/flood', {
      closeOnBackpressureLimit: true,
      message: socket => {
        for (let index = 0; index < 64; index++) statuses.push(socket.send(big))
      },
      close: (_socket, code) => {
        closes.push(code)
      },
    })
    const server = await start(app)
    const client = await openSocket(server.port, '/flood')

    client.send('go')

    expect((await client.closed).code).toBe(1006)
    await pause(20)
    expect(statuses).toContain(2)
    expect(closes).toEqual([1006])
  })
})
