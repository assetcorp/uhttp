import {
  JSON_PATH,
  PLAIN_BODY,
  PLAIN_PATH,
  RESPONSE_CHECK_TIMEOUT_MS,
  SECURITY_HEADERS,
  UPLOAD_BODY_BYTE_VALUE,
  UPLOAD_BODY_BYTES,
  UPLOAD_CONTENT_TYPE,
  UPLOAD_PATH,
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

export function routePath(route: RouteId): string {
  if (route === 'plain') return PLAIN_PATH
  if (route === 'json') return JSON_PATH
  return UPLOAD_PATH
}

function expectedReply(route: RouteId): ExpectedReply {
  if (route === 'plain') {
    return { path: PLAIN_PATH, init: {}, mediaType: 'text/plain', body: PLAIN_BODY }
  }
  if (route === 'json') {
    return { path: JSON_PATH, init: {}, mediaType: 'application/json', body: '{"hello":"world"}' }
  }
  return {
    path: UPLOAD_PATH,
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
  if (headers.get('strict-transport-security') !== null) {
    faults.push('strict-transport-security went out over plain HTTP')
  }
  if (headers.get('content-security-policy') !== null) {
    faults.push('content-security-policy went out, which no server in the suite sets')
  }
  return faults
}

export async function checkReplies(label: string, origin: string, variant: HeaderVariant): Promise<void> {
  for (const route of ['plain', 'json', 'upload'] as const) {
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
