# File uploads

`c.req.body.multipart()` reads a `multipart/form-data` body, which a browser sends for a form with a file input. It streams each file, one chunk at a time, into the destination that the `file` callback returns, and it resolves to the text fields together with the field name, the filename, the content type, and the size of each file.

```ts
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, serve } from '@delali/uhttp'

const UPLOADS_FOLDER = './uploads'
const PHOTO_ROUTE_MAX_BODY_BYTES = 20 * 1024 * 1024

mkdirSync(UPLOADS_FOLDER, { recursive: true })

const app = createApp({ logger: console }).post('/photos', { maxBodyBytes: PHOTO_ROUTE_MAX_BODY_BYTES }, async c => {
  const storedPaths: string[] = []
  const { fields, files } = await c.req.body.multipart({
    maxParts: 10,
    file: () => {
      const path = join(UPLOADS_FOLDER, randomUUID())
      storedPaths.push(path)
      return createWriteStream(path)
    },
  })
  const stored = files.map((file, index) => ({ name: file.filename, size: file.size, path: storedPaths[index] }))
  return c.json({ caption: fields.caption, stored }, 201)
})

await serve({ app, port: 3000 })
```

Send it a file over the network to check it:

```bash
curl -si -F caption='Product photo' -F photo=@product.jpg http://127.0.0.1:3000/photos
```

- Set `maxBodyBytes` on every upload route, because the body limit of the route, which is 1 MiB by default, also caps the whole upload and each file in it.
- Name each file on disk yourself, as the example does with `randomUUID()`, and store the filename from the client as data. uhttp keeps only the basename of a filename, so `../../etc/passwd` arrives as `passwd`, and it answers 400 with `INVALID_MULTIPART` for a field name or a filename with a control character.
- Without a `file` callback, `multipart()` keeps every file in memory and returns its bytes under `bytes`.
- To send a file to object storage, return an object with the stream under `stream` and a `discard` function, which uhttp calls when the upload fails, such as a `PassThrough` that the storage client reads and a function that aborts that upload. The callback can also return a promise of the destination.

## Limits

Past any of these limits, uhttp answers 413 with `PAYLOAD_TOO_LARGE` and closes the connection after the reply:

| Option of `multipart()` | What it limits | Default |
| --- | --- | --- |
| `maxParts` | The number of parts, fields and files together | 1,000 |
| `maxFieldBytes` | The size of each text field | 1 MiB |
| `maxFileBytes` | The size of each file | The body limit of the route |
| `maxTotalBytes` | The size of the whole body | The body limit of the route |

## When an upload fails

When the client disconnects, an upload passes a limit, the body is malformed, a destination fails, or the handler passes its time limit, uhttp destroys every destination of the request and rejects `multipart()` with the error. It deletes each file that `fs.createWriteStream()` opened by path, and it calls `discard` for a destination that has one, so every file left on disk comes from an upload that succeeded. After `multipart()` resolves, uhttp leaves the files in place.

While a destination has a full buffer, uhttp pauses the socket, so TCP flow control slows the client down. uhttp closes a connection whose socket stays paused for 10 seconds.

uWebSockets.js closes a connection, without a reply, when a body arrives at less than 16 KiB a second for about 10 seconds. When clients upload over slow networks, put a proxy in front that reads the whole body before it forwards the request, as [serving.md](serving.md) describes.
