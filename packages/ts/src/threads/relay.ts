import type { MessagePort } from 'node:worker_threads'
import type { Hub, PeerRelay } from '../websocket/hub.js'
import { isPeerMessage, type PeerMessage } from './messages.js'

interface Peer {
  readonly port: MessagePort
  readonly topics: Set<string>
}

/**
 * The relay of one worker holds a port to every other worker. It tells the other workers which
 * topics have subscribers on this thread, and it forwards a published message only to the workers
 * that have subscribers on its topic.
 *
 * @internal
 */
export class ThreadRelay implements PeerRelay {
  readonly #hub: Hub
  readonly #peers = new Map<number, Peer>()
  readonly #local = new Set<string>()

  /**
   * Creates the relay of one worker.
   *
   * @param hub - The worker passes its hub, which delivers each message from another worker to the
   * subscribers on this thread.
   */
  constructor(hub: Hub) {
    this.#hub = hub
  }

  /**
   * Adds the port to another worker, and tells that worker every topic that has subscribers on
   * this thread.
   *
   * @param id - The main thread passes the number of the other worker.
   * @param port - The main thread passes this end of the channel between the two workers.
   */
  addPeer(id: number, port: MessagePort): void {
    this.removePeer(id)
    const peer: Peer = { port, topics: new Set() }
    this.#peers.set(id, peer)
    port.on('message', (message: unknown) => {
      if (isPeerMessage(message)) this.#receive(peer, message)
    })
    port.on('close', () => {
      if (this.#peers.get(id) === peer) this.#peers.delete(id)
    })
    port.postMessage({ type: 'topics', topics: [...this.#local] } satisfies PeerMessage)
  }

  /**
   * Closes the port to a worker that has gone, and forgets the topics of that worker.
   *
   * @param id - The main thread passes the number of the worker that has gone.
   */
  removePeer(id: number): void {
    const peer = this.#peers.get(id)
    if (peer === undefined) return
    this.#peers.delete(id)
    peer.port.close()
  }

  /** Closes the port to every other worker. */
  close(): void {
    for (const id of [...this.#peers.keys()]) this.removePeer(id)
  }

  /**
   * Tells every other worker that a topic gained its first subscriber or lost its last on this thread.
   *
   * @param topic - The hub passes the name of the topic.
   * @param subscribed - The hub passes `true` for the first subscriber and `false` once the last one leaves.
   */
  announce(topic: string, subscribed: boolean): void {
    if (subscribed) this.#local.add(topic)
    else this.#local.delete(topic)
    const message: PeerMessage = { type: subscribed ? 'subscribe' : 'unsubscribe', topic }
    for (const peer of this.#peers.values()) peer.port.postMessage(message)
  }

  /**
   * Sends a published message to every other worker with a subscriber on its topic.
   *
   * @param topic - The hub passes the name of the topic.
   * @param message - The hub passes the message as text or as bytes that no other view shares.
   * @param binary - The hub passes `true` for a binary message.
   * @param compress - The hub passes `true` when the publisher asked for compression.
   */
  forward(topic: string, message: string | Uint8Array, binary: boolean, compress: boolean): void {
    let envelope: PeerMessage | undefined
    for (const peer of this.#peers.values()) {
      if (!peer.topics.has(topic)) continue
      envelope ??= { type: 'publish', topic, message, binary, compress }
      peer.port.postMessage(envelope)
    }
  }

  #receive(peer: Peer, message: PeerMessage): void {
    switch (message.type) {
      case 'topics':
        peer.topics.clear()
        for (const topic of message.topics) peer.topics.add(topic)
        return
      case 'subscribe':
        peer.topics.add(message.topic)
        return
      case 'unsubscribe':
        peer.topics.delete(message.topic)
        return
      case 'publish':
        this.#hub.deliver(message.topic, message.message, message.binary, message.compress)
    }
  }
}
