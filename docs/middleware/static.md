# Static files

The middleware that `serveStatic()` returns serves the files inside a folder for GET and HEAD requests. It passes every other request, and every request for a file that is missing from the folder, on to your routes.

```ts
import { createApp } from '@delali/uhttp'
import { serveStatic } from '@delali/uhttp/static'

const app = createApp()
  .use(serveStatic({ root: './public', prefix: '/assets' }))
  .get('/', c => c.text('Welcome to the shop'))
```

With that prefix, the middleware serves `./public/app.js` for `GET /assets/app.js` and `./public/index.html` for `GET /assets/`. Create the folder before you call `serveStatic()`, because `serveStatic()` throws `INVALID_MIDDLEWARE_OPTIONS` for a folder that doesn't exist.

| Option | Meaning |
| --- | --- |
| `root` | The middleware serves the files inside this folder. |
| `prefix` | The middleware serves the requests whose path starts with this prefix, such as `/assets`. The prefix is `/` by default. |
| `index` | The middleware serves this file for a request to a folder that ends with `/`, which is `index.html` by default. Pass `false` to serve no index file. |
| `cacheControl` | The middleware sends this `Cache-Control` with every file, which is `public, max-age=0` by default. |
| `dotfiles` | With `ignore`, the default, the middleware skips a path with a segment that starts with a dot, apart from `.well-known`. Pass `allow` to serve such files. |

## Which paths map to a file

The middleware checks each path the way that the router checks a route. It decodes each segment once, and the package replies with a 404 when the raw path differs from the canonical spelling of its decoded form. The package therefore replies with a 404 to `/assets/%2E%2E/secret.txt`, to `/assets//app.js`, and to `/assets/caf%c3%a9.txt` with lowercase hex, while the middleware serves `/assets/caf%C3%A9.txt`. In the canonical spelling, the characters of the path alphabet appear as they are, and every other byte appears in uppercase hex, so the middleware serves the file `a b.txt` to a browser that follows a link to `/assets/a%20b.txt`.

The middleware serves only the files inside the folder. On a case-insensitive filesystem, as on macOS by default, it compares the spelling on disk with the spelling in the path, so it passes `/assets/APP.JS` on to your routes when the file is `app.js`. It follows a symlink only when the target is inside the folder. It serves regular files alone, so the middleware passes a request for a folder without the trailing slash, or for a named pipe, on to your routes.

Because the package replies with a 404 to a path that is not canonical, the package never calls the handler of a later route for such a path. When a route has a parameter whose values a client can encode in more than one way, mount the static files under a prefix such as `/assets`, so that the package replies with a 404 only to paths inside that prefix.

## Caching and ranges

The middleware sends each file with a content type from its extension, a weak `ETag` that it builds from the size and the modification time of the file, and `Last-Modified`. It sends a file with an unknown extension as `application/octet-stream`. When the client sends `If-None-Match` with the current tag, or sends no `If-None-Match` and an `If-Modified-Since` date no earlier than the modification time, the middleware replies with a 304.

For a request for one byte range, such as `Range: bytes=1000-1999`, the middleware replies with a 206 and those bytes, so that a video player can seek. For a range that starts past the end of the file, the package replies with a 416 and `Content-Range: bytes */<size>`. The middleware sends the whole file for a request with several ranges, and for an `If-Range` other than the exact `Last-Modified` date of the file.

Set a long lifetime in `cacheControl` for files whose names change with each build, such as `app.3f9a1c.js`, so that a browser reuses them without checking with the server:

```ts
app.use(serveStatic({ root: './dist/assets', prefix: '/assets', cacheControl: 'public, max-age=31536000, immutable' }))
```

## Large files and slow clients

The middleware streams each file in chunks of 64 KiB, and it loads the next chunk from disk only once the package has written the last one to the socket, so the server keeps no more than one chunk of the file in memory for a slow client. The middleware opens the file when the package starts to send the body, and it closes the file once the package sends the body or the client disconnects. Add [`compression()`](compression.md) before `serveStatic()` to compress text files such as CSS and JavaScript.
