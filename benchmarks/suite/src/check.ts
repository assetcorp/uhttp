import {
  FRAMING_HEADERS,
  PLAIN_BODY,
  RESPONSE_CHECK_TIMEOUT_MS,
  ROUTE_IDS,
  ROUTE_PATHS,
  SECURITY_HEADERS,
  UPLOAD_BODY_BYTE_VALUE,
  UPLOAD_BODY_BYTES,
  UPLOAD_CONTENT_TYPE,
} from './constants.ts'
import type { HeaderVariant, RouteId } from './types.ts'

interface ExpectedReply {
  readonly path: string
  readonly init: RequestInit
  readonly mediaType: string
  readonly body: string
}

export function uploadBody(): Buffer {
  return Buffer.alloc(UPLOAD_BODY_BYTES, UPLOAD_BODY_BYTE_VALUE)
}

function expectedReply(route: RouteId): ExpectedReply {
  if (route === 'plain') {
    return { path: ROUTE_PATHS.plain, init: {}, mediaType: 'text/plain', body: PLAIN_BODY }
  }
  if (route === 'json') {
    return { path: ROUTE_PATHS.json, init: {}, mediaType: 'application/json', body: '{"hello":"world"}' }
  }
  return {
    path: ROUTE_PATHS.upload,
    init: { method: 'POST', headers: { 'content-type': UPLOAD_CONTENT_TYPE }, body: uploadBody() },
    mediaType: 'application/json',
    body: `{"bytes":${UPLOAD_BODY_BYTES}}`,
  }
}

function securityHeaderFaults(headers: Headers, variant: HeaderVariant): string[] {
  const faults: string[] = []
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    const sent = headers.get(name)
    if (variant === 'secure' && sent !== value) faults.push(`${name} was '${sent}' in place of '${value}'`)
    if (variant === 'plain' && sent !== null) faults.push(`${name} was '${sent}' on a server without security headers`)
  }
  for (const name of headers.keys()) {
    if (!FRAMING_HEADERS.includes(name) && !Object.hasOwn(SECURITY_HEADERS, name)) {
      faults.push(`the server sent ${name}, which every other server leaves out`)
    }
  }
  return faults
}

export async function checkReplies(label: string, origin: string, variant: HeaderVariant): Promise<void> {
  for (const route of ROUTE_IDS) {
    const expected = expectedReply(route)
    const response = await fetch(`${origin}${expected.path}`, {
      ...expected.init,
      signal: AbortSignal.timeout(RESPONSE_CHECK_TIMEOUT_MS),
    })
    const body = await response.text()
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
    const faults = securityHeaderFaults(response.headers, variant)
    if (response.status !== 200) faults.push(`the status was ${response.status}`)
    if (mediaType !== expected.mediaType) faults.push(`the media type was '${mediaType}'`)
    if (body !== expected.body) faults.push(`the body was '${body.slice(0, 200)}'`)
    if (faults.length > 0) {
      throw new Error(`The ${label} server answered ${route} wrongly: ${faults.join('; ')}.`)
    }
  }
}
