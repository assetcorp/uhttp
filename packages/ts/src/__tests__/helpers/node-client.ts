import { type Agent, type IncomingMessage, request } from 'node:http'

export interface NodeClientResult {
  status: number | undefined
  connectionHeader: string | undefined
  contentLength: string | undefined
  body: Buffer
  reusedSocket: boolean
  errors: string[]
}

export interface NodeClientRequest {
  port: number
  path: string
  method?: string
  headers?: Record<string, string | number>
  body?: Buffer
  agent?: Agent
}

export async function sendFromNodeClient(options: NodeClientRequest): Promise<NodeClientResult> {
  const outgoing = request({
    host: '127.0.0.1',
    port: options.port,
    path: options.path,
    method: options.method ?? 'GET',
    agent: options.agent ?? false,
    headers: options.headers ?? {},
  })
  const errors: string[] = []
  outgoing.on('error', error => errors.push(error.message))
  const closed = new Promise<void>(resolve => outgoing.on('close', () => resolve()))
  const responded = new Promise<IncomingMessage>(resolve => outgoing.on('response', resolve))
  outgoing.end(options.body)
  const response = await responded
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  await closed
  return {
    status: response.statusCode,
    connectionHeader: response.headers.connection,
    contentLength: response.headers['content-length'],
    body: Buffer.concat(chunks),
    reusedSocket: outgoing.reusedSocket,
    errors,
  }
}
