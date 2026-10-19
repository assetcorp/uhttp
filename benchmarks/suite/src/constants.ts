export const SERVER_IDS = ['uws', 'uhttp', 'hono', 'fastify', 'express'] as const

export const ROUTE_IDS = ['plain', 'json', 'upload'] as const

export const HEADER_VARIANTS = ['plain', 'secure'] as const

export const DEFAULT_CONNECTION_LEVELS = [10, 50, 100, 250, 500] as const

export const HEADLINE_CONNECTIONS = 100

export const PIPELINED_REQUESTS = 10

export const DEFAULT_MEASURE_DURATION_MS = 40_000

export const DEFAULT_WARM_UP_DURATION_MS = 40_000

export const DEFAULT_LOAD_THREADS = 4

export const SMOKE_MEASURE_DURATION_MS = 2_000

export const SMOKE_WARM_UP_DURATION_MS = 1_000

export const SMOKE_CONNECTION_LEVELS = [10, 100] as const

export const PINNED_SERVER_CPU = 1

export const FIRST_PINNED_LOAD_CPU = 2

export const LOAD_TIMEOUT_GRACE_MS = 30_000

export const LOAD_OUTPUT_MAX_BYTES = 16_777_216

export const TOOL_OUTPUT_TIMEOUT_MS = 10_000

export const SERVER_START_TIMEOUT_MS = 10_000

export const SERVER_STOP_TIMEOUT_MS = 5_000

export const CPU_REPORT_TIMEOUT_MS = 5_000

export const RESPONSE_CHECK_TIMEOUT_MS = 5_000

export const HEADER_VARIANT_ENV = 'BENCHMARK_HEADERS'

export const CPU_USAGE_REQUEST = 'cpu-usage'

export const PLAIN_PATH = '/plain'

export const PLAIN_BODY = 'Hello, World!'

export const JSON_PATH = '/json'

export const JSON_BODY = { hello: 'world' } as const

export const UPLOAD_PATH = '/upload'

export const UPLOAD_BODY_BYTES = 16_384

export const UPLOAD_BODY_BYTE_VALUE = 0x61

export const UPLOAD_CONTENT_TYPE = 'application/octet-stream'

export const SECURITY_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
} as const

export const RUNS_DIRECTORY = 'benchmarks/results/runs'

export const SMOKE_RUNS_DIRECTORY = 'benchmarks/results/.smoke/runs'

export const PROFILE_ENV = 'BENCH_PROFILE'

export const BENCH_PROFILES = ['published', 'smoke'] as const

export const WRITEUP_DIRECTORY = 'benchmarks/writeup'

export const RESULTS_FILE = 'results.json'

export const MACHINE_FILE = 'machine.json'

export const RESULTS_SCHEMA_VERSION = 1
