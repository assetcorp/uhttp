import helmet from '@fastify/helmet'
import Fastify from 'fastify'
import { JSON_BODY, JSON_PATH, PLAIN_BODY, PLAIN_PATH, UPLOAD_CONTENT_TYPE, UPLOAD_PATH } from '../constants.ts'
import { announce, failToListen, wantsSecurityHeaders } from './announce.ts'

const jsonRouteSchema = {
  schema: {
    response: {
      200: { type: 'object', properties: { hello: { type: 'string' } } },
    },
  },
}

const app = Fastify()
if (wantsSecurityHeaders()) {
  await app.register(helmet, { contentSecurityPolicy: false, strictTransportSecurity: false })
}

app.addContentTypeParser(UPLOAD_CONTENT_TYPE, { parseAs: 'buffer' }, (_request, body, done) => {
  done(null, body)
})

app.get(PLAIN_PATH, (_request, reply) => {
  reply.send(PLAIN_BODY)
})
app.get(JSON_PATH, jsonRouteSchema, (_request, reply) => {
  reply.send(JSON_BODY)
})
app.post(UPLOAD_PATH, (request, reply) => {
  if (!Buffer.isBuffer(request.body)) throw new Error('The Fastify upload route received a body without bytes.')
  reply.send({ bytes: request.body.byteLength })
})

await app.listen({ port: 0, host: '127.0.0.1' })
const address = app.server.address()
if (address === null || typeof address === 'string') failToListen('Fastify')
announce(address.port)
