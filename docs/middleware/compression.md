# Compression

The middleware that `compression()` returns compresses a response with Brotli, zstd, or gzip, according to the encodings that the client lists in the `Accept-Encoding` header of the request.

```ts
import { createApp } from '@delali/uhttp'
import { compression } from '@delali/uhttp/compression'

const app = createApp()
  .use(compression())
  .get('/products', c => c.json(products))
```

The middleware compresses with Brotli at quality 4, on a scale from 0 to 11, where Brotli spends less CPU time at a lower quality. By default, the middleware picks `br` first, then `zstd`, and then `gzip`. On a version of Node without zstd, it skips `zstd`. When the client weights its encodings with `q` values, the middleware picks the encoding with the highest weight, and it breaks a tie with the order of your preference. Pass `encodings` to change that order:

```ts
app.use(compression({ encodings: ['gzip'] }))
```

## What the middleware compresses

The middleware compresses a body of at least 1,024 bytes, which you can change with `threshold`, when its content type is text, JSON, XML, JavaScript, or SVG. It leaves out `text/event-stream`, because a compressor can buffer the bytes of one event until your code writes later events.

The middleware leaves a response unchanged when any of these is true:

- The status is 204, 206, or 304.
- The response already has `Content-Encoding`.
- The response has `Cache-Control: no-transform`.
- You called `skipCompression(c)` on the route.

The middleware adds `Vary: Accept-Encoding` to every other response of a compressible type, so that a cache keeps the compressed and the uncompressed copy apart. It also adds that header to the response to a HEAD request, which it never compresses. When the middleware compresses a body, it turns a strong `ETag` into a weak one, because the bytes of the compressed body differ from the bytes for which your app computed the tag.

## Streams

The middleware compresses a streamed reply chunk by chunk and sends it chunked, without a `Content-Length`. Each write of your producer resolves only once the package has passed the compressed bytes before it to the socket, so a slow client slows your producer down, as it does without compression. When the client disconnects, the middleware stops the compressor, so the next write of your producer resolves to `false`.

A compressor can buffer the bytes of a small write until your producer writes enough bytes to compress. The middleware flushes that buffer when your producer returns, so call `skipCompression(c)` on a route whose client must receive each write as soon as your producer makes it, such as a progress feed.

The middleware compresses a body that is not a stream with the asynchronous functions of `node:zlib`, which Node.js executes on its thread pool, so that the package can serve other requests in the meantime.

## Secrets next to text from the request

When a response contains a secret, such as a CSRF token, next to text that an attacker can put into the request, the attacker can guess the secret one character at a time from the size of the compressed responses. The researchers who found this attack named it [BREACH](https://www.breachattack.com/). Call `skipCompression(c)` on such a route:

```ts
import { skipCompression } from '@delali/uhttp/compression'

app.get('/account', c => {
  skipCompression(c)
  return c.text(accountPage(c.req.query, csrfTokenFor(c)), 200, { 'content-type': 'text/html' })
})
```

## Compress at the proxy

The middleware uses CPU time on the threads of your server. When a CDN or a load balancer forwards requests to your servers, let it compress the responses, and leave `compression()` out of your app.
