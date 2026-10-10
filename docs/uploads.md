# Uploads

`c.req.body.multipart()` reads a `multipart/form-data` body, which is the format that a browser sends for a form with a file input. It writes each file into a destination that you choose, such as a file on disk or a stream to object storage, one chunk at a time, so that a large upload never has to fit in memory. It keeps the text fields in memory and returns them together with the details of each file.

```ts
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '@delali/uhttp'

const app = createApp().post('/photos', { maxBodyBytes: 20 * 1024 * 1024 }, async c => {
  const { fields, files } = await c.req.body.multipart({
    file: () => createWriteStream(join('/var/uploads', randomUUID())),
  })
  return c.json({ caption: fields.caption, stored: files.map(file => file.size) }, 201)
})
```

The package parses the body itself, with the design that busboy uses. When the end of one chunk could be the start of a boundary, the parser keeps those bytes and completes the match with the next chunk, so it finds a boundary that two chunks split between them.

## Choose a destination for each file

The package calls your `file` callback once for each file, before the first byte of that file, with the field name, the filename, and the content type that the client sent. Return a Node `Writable`, a web `WritableStream`, or a promise of either one from the callback. You can also return an object with the stream under `stream` and a `discard` function, which the package calls when the upload fails:

```ts
import { PassThrough } from 'node:stream'

await c.req.body.multipart({
  file: async file => {
    const stream = new PassThrough()
    const upload = await storage.beginUpload(file.contentType, stream)
    return { stream, discard: () => upload.abort() }
  },
})
```

In that example, `storage` stands for the client of your object store. When you pass no `file` callback, `multipart()` returns the bytes of each file under `bytes`, so the package holds every file in memory, up to the limits in the next section.

The package keeps only the basename of a filename, so `../../etc/passwd` becomes `passwd` and a basename of `.` or `..` becomes an empty name. It answers 400 with the code `INVALID_MULTIPART` for a field name or a filename that contains a control character. Even after that cut, the filename comes from the client, so name each file on disk yourself, as the first example does with `randomUUID()`, and store the client's filename as data.

## Limits

Every limit of an upload has a finite default. Once an upload passes one of them, the package answers 413 with the code `PAYLOAD_TOO_LARGE`. Pass any of these four to `multipart()`:

| Option | What it limits | Default |
| --- | --- | --- |
| `maxParts` | The number of parts, fields and files together | 1,000 |
| `maxFieldBytes` | The size of each field value | 1 MiB |
| `maxFileBytes` | The size of each file | The body limit of the route |
| `maxTotalBytes` | The size of the whole multipart body | The body limit of the route |

The package also limits every part to 16 header lines and 16 KiB of headers, and every field name to 256 bytes. It answers 400 with the code `INVALID_MULTIPART` for a boundary outside 1 to 70 characters from the alphabet of [RFC 2046](https://www.rfc-editor.org/rfc/rfc2046.html#section-5.1.1), for a part without a `form-data` disposition and a name, and for a body that ends before its closing boundary. Because the parser counts the bytes as it receives them, the package enforces the body limit of the route and the limits of the upload whatever length the client declares.

## A slow destination slows the client

While a destination has a full buffer, the package waits for it to drain before it parses more of the body. Once the package holds 64 KiB of the body that the parser hasn't read, it pauses the uWebSockets.js socket until the parser reads enough to bring that figure below 64 KiB. The kernel's receive buffer for the connection then fills, so TCP flow control slows the client down.

uWebSockets.js clears its idle timer while a socket is paused, so the package keeps a timer of its own and closes the connection when the socket has been paused for 10 seconds.

## What happens when an upload fails

The package destroys every destination of the request when the client disconnects, when the upload passes a limit, when the body is not valid multipart, when a destination fails, or when the handler passes its time limit. For a stream from `fs.createWriteStream()` with a path, it waits for the stream to close and then deletes the file. For a destination with a `discard` function, it calls that function and deletes nothing itself. It does the same for the files that earlier parts of the request finished, so that every file on disk comes from an upload that succeeded. `multipart()` then rejects with the error, and after the reply the package discards the rest of the body, so that the connection can serve the next request.

However, when the time limit passes or the client disconnects after `multipart()` resolves, the package leaves the files in place.

## Test an upload

Because the network can split a boundary between two chunks, pass the multipart body to `app.request()` as a list of chunks, and split it at every byte position, as the tests of the package do:

```ts
const body = Buffer.from(
  '--frontier\r\nContent-Disposition: form-data; name="caption"\r\n\r\nKakum canopy\r\n--frontier--\r\n',
)

for (let position = 1; position < body.byteLength; position++) {
  const response = await app.request('/photos', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=frontier' },
    body: [body.subarray(0, position), body.subarray(position)],
  })
  console.assert(response.status === 201)
}
```
