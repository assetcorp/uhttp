import type { Segment } from './pattern.js'

interface Node<T> {
  readonly statics: Map<string, Node<T>>
  parameter: Node<T> | undefined
  value: T | undefined
}

/**
 * The matcher returns the value of the route that matches a request, together with the raw
 * parameter values in the order of the route path.
 *
 * @internal
 */
export interface Match<T> {
  /** The matcher stored this value when you added the route. */
  readonly value: T
  /** The matcher returns the parameter values raw, so the caller decodes each one once. */
  readonly parameters: readonly string[]
}

function createNode<T>(): Node<T> {
  return { statics: new Map(), parameter: undefined, value: undefined }
}

function walk<T>(node: Node<T>, segments: readonly string[], index: number, parameters: string[]): T | undefined {
  if (index === segments.length) return node.value
  const segment = segments[index]
  if (segment === undefined) return undefined
  const exact = node.statics.get(segment)
  if (exact !== undefined) {
    const found = walk(exact, segments, index + 1, parameters)
    if (found !== undefined) return found
  }
  if (node.parameter === undefined || segment === '') return undefined
  parameters.push(segment)
  const found = walk(node.parameter, segments, index + 1, parameters)
  if (found === undefined) parameters.pop()
  return found
}

/**
 * The JavaScript matcher works as the router of uWebSockets.js does. It compares the method
 * exactly, including its case. At each segment, it tries the static branch before the parameter
 * branch, and it backtracks when a branch fails further along the path. A parameter matches any
 * raw segment that is not empty.
 *
 * @internal
 */
export class Matcher<T> {
  readonly #roots = new Map<string, Node<T>>()

  /**
   * Adds a route under one method.
   *
   * @param method - The matcher compares this method exactly, including its case.
   * @param segments - You pass the segments of the route path.
   * @param value - The matcher returns this value for a request that matches.
   * @returns The method returns `false` when the method already has a route of the same shape,
   * which means the same static text and parameters in the same positions.
   */
  add(method: string, segments: readonly Segment[], value: T): boolean {
    let node = this.#roots.get(method)
    if (node === undefined) {
      node = createNode()
      this.#roots.set(method, node)
    }
    for (const segment of segments) {
      if (segment.kind === 'parameter') {
        node.parameter ??= createNode()
        node = node.parameter
        continue
      }
      let next = node.statics.get(segment.text)
      if (next === undefined) {
        next = createNode()
        node.statics.set(segment.text, next)
      }
      node = next
    }
    if (node.value !== undefined) return false
    node.value = value
    return true
  }

  /**
   * Returns the route of one method that matches the raw segments of a path.
   *
   * @param method - The matcher compares this method exactly, including its case.
   * @param segments - You pass the raw segments of the request path.
   * @returns The method returns the match, or `undefined` when no route of the method matches.
   */
  match(method: string, segments: readonly string[]): Match<T> | undefined {
    const root = this.#roots.get(method)
    if (root === undefined) return undefined
    const parameters: string[] = []
    const value = walk(root, segments, 0, parameters)
    return value === undefined ? undefined : { value, parameters }
  }

  /**
   * Returns every method that has at least one route.
   *
   * @returns The method returns the methods in the order in which you added their first routes.
   */
  methods(): string[] {
    return [...this.#roots.keys()]
  }
}
