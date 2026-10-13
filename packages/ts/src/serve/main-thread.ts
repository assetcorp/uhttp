import type { TemplatedApp } from 'uWebSockets.js'
import { compiledOf, setPublisher } from '../app.js'
import type { CompiledApp } from '../compile.js'
import { CLOSING, Drain, RETIRING } from '../native/drain.js'
import type { Hub } from '../websocket/hub.js'
import { withinGrace } from './grace.js'
import { type Listener, listenOn } from './listen.js'
import { importApp } from './module.js'
import { hubOf, nativeAppOf, processOrigin, registerApp, type Uws } from './native.js'
import type { CheckedServeOptions } from './options.js'
import { closingError, reloadWithoutTlsError, type Server, serverOf } from './server.js'
import type { CheckedTls } from './tls-options.js'

interface Generation {
  readonly native: TemplatedApp
  readonly drain: Drain
  closed: boolean
}

interface Https {
  readonly tls: CheckedTls
  readonly acceptor: TemplatedApp
}

function generationOf(native: TemplatedApp): Generation {
  return { native, drain: new Drain(), closed: false }
}

function closeGeneration(generation: Generation): void {
  if (generation.closed) return
  generation.closed = true
  generation.native.close()
}

class MainThreadServer {
  readonly #uws: Uws
  readonly #options: CheckedServeOptions
  readonly #compiled: CompiledApp
  readonly #hub: Hub | undefined
  readonly #https: Https | undefined
  readonly #retiring = new Set<Generation>()
  #current: Generation
  #listener: Listener | undefined
  #closing = false

  constructor(uws: Uws, options: CheckedServeOptions, compiled: CompiledApp, start: Started) {
    this.#uws = uws
    this.#options = options
    this.#compiled = compiled
    this.#current = start.generation
    this.#hub = start.hub
    this.#https = start.https
  }

  async listen(): Promise<Listener> {
    this.#listener = await listenOn(this.#uws, this.#https?.acceptor ?? this.#current.native, this.#options.address)
    return this.#listener
  }

  async close(): Promise<void> {
    this.#closing = true
    await this.#listener?.close()
    const generations = [this.#current, ...this.#retiring]
    const drained = generations.map(async generation => {
      await generation.drain.start(CLOSING)
      closeGeneration(generation)
    })
    await withinGrace(Promise.all(drained), this.#options.gracePeriodMs)
    await this.#hub?.close()
    for (const generation of generations) closeGeneration(generation)
    this.#https?.acceptor.close()
  }

  async reload(): Promise<void> {
    const https = this.#https
    if (https === undefined) throw reloadWithoutTlsError()
    if (this.#closing) throw closingError()
    const next = generationOf(await nativeAppOf(this.#uws, https.tls, true))
    try {
      await registerApp(this.#uws, next.native, this.#compiled, this.#hub, next.drain, https.tls)
    } catch (error) {
      closeGeneration(next)
      throw error
    }
    if (this.#closing) {
      closeGeneration(next)
      throw closingError()
    }
    const previous = this.#current
    https.acceptor.addChildAppDescriptor(next.native.getDescriptor())
    https.acceptor.removeChildAppDescriptor(previous.native.getDescriptor())
    this.#hub?.useNative(next.native)
    this.#current = next
    this.#retiring.add(previous)
    void withinGrace(previous.drain.start(RETIRING), this.#options.gracePeriodMs).then(() => {
      closeGeneration(previous)
      this.#retiring.delete(previous)
    })
  }
}

interface Started {
  readonly generation: Generation
  readonly hub: Hub | undefined
  readonly https: Https | undefined
}

async function startApp(uws: Uws, compiled: CompiledApp, tls: CheckedTls | undefined): Promise<Started> {
  const native = await nativeAppOf(uws, tls, true)
  const generation = generationOf(native)
  let hub: Hub | undefined
  let https: Https | undefined
  try {
    hub = await hubOf(native, compiled, processOrigin())
    await registerApp(uws, native, compiled, hub, generation.drain, tls)
    await hub?.start()
    if (tls !== undefined) {
      const { secureApp } = await import('./tls.js')
      https = { tls, acceptor: secureApp(uws, tls, false) }
      https.acceptor.addChildAppDescriptor(native.getDescriptor())
    }
  } catch (error) {
    await hub?.close()
    native.close()
    throw error
  }
  return { generation, hub, https }
}

/**
 * Starts a server whose main thread serves every request. With `tls`, an app of uWebSockets.js
 * accepts each connection and passes it to a second app on the same thread that serves it, so that
 * the package can swap the second app for one with renewed certificates during a reload.
 *
 * @param uws - The package passes the module of uWebSockets.js.
 * @param options - The package passes the checked options of the server.
 * @returns The promise resolves to the server once it listens.
 * @throws {@link UhttpError} with the codes that {@link serve} documents.
 * @internal
 */
export async function serveOnMainThread(uws: Uws, options: CheckedServeOptions): Promise<Server> {
  const app = options.app instanceof URL ? await importApp(options.app) : options.app
  const compiled = compiledOf(app)
  const started = await startApp(uws, compiled, options.tls)
  const server = new MainThreadServer(uws, options, compiled, started)
  let listener: Listener
  try {
    listener = await server.listen()
  } catch (error) {
    await server.close()
    throw error
  }
  const { hub } = started
  if (hub !== undefined) {
    setPublisher(app, (topic, message, publishOptions) => hub.publish(topic, message, publishOptions))
  }
  return serverOf(listener.port, {
    close: async () => {
      setPublisher(app, undefined)
      await server.close()
    },
    reload: () => server.reload(),
  })
}
