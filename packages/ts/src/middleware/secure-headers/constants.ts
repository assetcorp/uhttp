/** The middleware sends this header only on TLS or behind a trusted proxy that reports `https`. */
export const STRICT_TRANSPORT_SECURITY = 'strict-transport-security'

/** The middleware sends the policy that your nonce function returns in this header. */
export const CONTENT_SECURITY_POLICY = 'content-security-policy'

/** The middleware generates this many random bytes for each nonce, which come to 24 characters in base64. */
export const NONCE_BYTES = 16

/** With either preset, the middleware sends this `Strict-Transport-Security` value, so that a browser uses HTTPS for the site for the next 180 days. */
export const DEFAULT_STRICT_TRANSPORT_SECURITY = 'max-age=15552000; includeSubDomains'

/** The `web` preset sends these headers, apart from `Strict-Transport-Security`. */
export const WEB_PRESET_HEADERS: Readonly<Record<string, string>> = {
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
}

/** The `api` preset sends these headers, apart from `Strict-Transport-Security`. */
export const API_PRESET_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}
