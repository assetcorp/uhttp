# Rate limits

The middleware that `rateLimit()` returns counts the requests of each client in fixed windows, so that it can reply with a 429 to every request over the limit.

```ts
import { createApp } from '@delali/uhttp'
import { rateLimit } from '@delali/uhttp/rate-limit'

const perMinute = rateLimit({ limit: 100, windowMs: 60_000 })

const app = createApp()
  .use(perMinute)
  .get('/products', c => c.json(products))
```

Each window begins at the first request of a client and lasts for `windowMs`, which is at least 1,000 milliseconds. The package replies to a request over the limit with a 429, the code `RATE_LIMITED`, and a `Retry-After` header set to the number of seconds until the window ends. It never calls the handler for that request.

## The headers of each response

The middleware adds the `RateLimit-Policy` and `RateLimit` headers of the IETF draft [RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) to every response. In `RateLimit-Policy`, `q` is the limit and `w` is the window in seconds, while in `RateLimit`, `r` is the number of requests that remain and `t` is the number of seconds until the window ends:

```
RateLimit-Policy: "default";q=100;w=60
RateLimit: "default";r=42;t=30
```

Pass `legacyHeaders: true` to send `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` as well, for clients that use those older names. The value of `X-RateLimit-Reset` is the end of the window in seconds since the epoch.

## Choose the key

By default, the middleware counts the requests of each client address in its canonical form, so it counts `::ffff:192.0.2.4` as `192.0.2.4`. It counts every IPv6 address in one /64 as one client, because a host can generate new addresses within its /64 at any time, as it does for the temporary addresses of [RFC 8981](https://www.rfc-editor.org/rfc/rfc8981). Add `trustedProxies()` before `rateLimit()` when your app serves requests behind a proxy, because otherwise the middleware will count every client as the proxy:

```ts
import { trustedProxies } from '@delali/uhttp/trusted-proxies'

app.use(trustedProxies({ trust: ['10.0.0.0/8'] })).use(perMinute)
```

Pass a `key` function, which can be async, to count the requests of another key, such as an API key. List the request headers that the function uses in `headers`, so that the middleware declares them on every route that you add it to:

```ts
const perApiKey = rateLimit({
  limit: 1_000,
  windowMs: 60_000,
  headers: ['x-api-key'],
  key: c => c.req.header('x-api-key') ?? 'anonymous',
})
```

## Worker threads share each count

The built-in store keeps its counts in memory that every worker thread of a server shares, so a client that connects to several workers can still send only `limit` requests in a window. The package assigns the first table in that memory to the first rate limiter that a worker builds, the second table to the second rate limiter, and so on. Build each rate limiter once, when Node loads the module of your app, so that every worker builds the same rate limiters in the same order. When `server.reload()` replaces a worker, the new worker takes over the tables of the old one, so the package keeps the counts across the reload as long as the `maxKeys` of each rate limiter stays the same.

The built-in store keeps up to `maxKeys` keys, which is 10,000 by default and 1,048,576 at most. The store keeps each key in a slot of 72 bytes, in a table with twice as many slots as keys, rounded up to a power of two. With the default, a table therefore has 32,768 slots of 72 bytes, or 2.25 MiB. Your app can build up to 64 rate limiters with the built-in store, and the package can reserve up to 1 GiB for their tables together. Beyond either limit, `rateLimit()` throws `INVALID_MIDDLEWARE_OPTIONS`. The store keeps a key of up to 40 bytes as it is, and the SHA-256 digest of any longer key. It hashes each key with a random seed that the package generates when it creates the table, so that the keys of a client spread across the table even when the client chooses them, such as through a header that your key function uses. The store also removes expired keys on a timer.

When the store is full and a client sends a request with a new key, the package samples up to 16 keys from a random slot onwards. It removes the first of them whose window has ended, or the least recently used of them when every window is still open, and it counts the new key in its place. The client of the removed key starts a new window with its next request. The package writes one warning to the logger of the app the first time that it removes a key whose window is still open. Raise `maxKeys` when you see that warning, because a client that spreads its requests across many keys, such as the /64 prefixes of an IPv6 /48, can otherwise reset the counts of other clients.

## Twice the limit around the end of a window

With fixed windows, the middleware can serve up to twice the limit within a span of less than `windowMs`. A client can start a window with one request and send the rest of the limit at the end of that window. The client can then send the full limit again as soon as the next window begins. When you need the limit to apply to every span of `windowMs`, write a store that counts in a sliding window, with an `increment` method like the one in the Redis example below.

## Count in Redis

The built-in store keeps its counts in the memory of one server. To share each count across processes or machines, pass a `store` with an `increment` method. The method counts one request of a key and returns the count in the current window, including this request, together with the end of the window in milliseconds since the epoch. This example store calls Redis through the [node-redis](https://github.com/redis/node-redis) client, with the `NX` option of [`PEXPIRE`](https://redis.io/docs/latest/commands/pexpire/), which Redis added in version 7.0.0:

```ts
import { createClient } from 'redis'
import { rateLimit, type RateLimitStore } from '@delali/uhttp/rate-limit'

const redis = await createClient({ url: process.env.REDIS_URL }).connect()

const redisStore: RateLimitStore = {
  async increment(key, windowMs) {
    const name = `rate-limit:${key}`
    const [count, , remainingMs] = await redis.multi().incr(name).pExpire(name, windowMs, 'NX').pTTL(name).exec()
    return { count: Number(count), resetAt: Date.now() + Number(remainingMs) }
  },
}

const perMinute = rateLimit({ limit: 100, windowMs: 60_000, store: redisStore })
```

The package applies `maxKeys` to the built-in store alone, so `rateLimit()` throws `INVALID_MIDDLEWARE_OPTIONS` when you pass it together with a `store`. When your store returns no numeric `count` and `resetAt`, the package replies to the request with a 500.
