import express from 'express'
import helmet from 'helmet'
import { JSON_BODY, JSON_PATH, PLAIN_BODY, PLAIN_PATH, UPLOAD_CONTENT_TYPE, UPLOAD_PATH } from '../constants.ts'
import { announce, failToListen, securityHeadersRequested } from './announce.ts'

const app = express()
app.disable('etag')
app.disable('x-powered-by')
if (securityHeadersRequested()) app.use(helmet({ contentSecurityPolicy: false, strictTransportSecurity: false }))

app.get(PLAIN_PATH, (_request, response) => {
  response.type('text/plain').send(PLAIN_BODY)
})
app.get(JSON_PATH, (_request, response) => {
  response.json(JSON_BODY)
})
app.post(UPLOAD_PATH, express.raw({ type: UPLOAD_CONTENT_TYPE }), (request, response) => {
  if (!Buffer.isBuffer(request.body)) throw new Error('The Express upload route received a body without bytes.')
  response.json({ bytes: request.body.byteLength })
})

const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') failToListen('Express')
  announce(address.port)
})
