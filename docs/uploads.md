# Uploads

`c.req.body.multipart()` reads a `multipart/form-data` body, the format that a browser sends for a form with a file input. It streams each file into a destination that you choose, such as a file on disk or a stream to object storage, so that the server has about one chunk of a large upload in memory at a time. It keeps the text fields in memory and returns them together with the details of each file.

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

The parser is part of the package, and it follows the design of busboy: a state machine over a streaming search for the boundary between parts, which finds a boundary that falls across two chunks of the body.

## Choose a destination for each file

The package calls your `file` callback once for each file, before the first byte of that file, with the field name, the filename, and the content type that the client sent. The callback returns a Node `Writable`, a web `WritableStream`, or a promise of either one. It can also return an object with the stream under `stream` and a `discard` function, which the package calls when the upload fails:

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

In that example, `storage` stands for the client of your object store. When you pass no `file` callback, the package keeps each file in memory and returns its bytes under `bytes`, within the limits in the next section.

The package keeps the basename of a filename alone, so `../../etc/passwd` arrives as `passwd`, and it turns a basename of `.` or `..` into an empty name. It refuses a field name or a filename that contains a control character. A filename still comes from the client, so name each file on disk yourself, as the first example does with `randomUUID()`, and keep the client's filename as data.

## Limits

Every limit of an upload is finite by default, and the package answers 413 with the code `PAYLOAD_TOO_LARGE` once the upload passes one. Pass the first four to `multipart()`:

| Option | What it limits | Default |
| --- | --- | --- |
| `maxParts` | The number of parts, fields and files together | 1,000 |
| `maxFieldBytes` | The size of each field value | 1 MiB |
| `maxFileBytes` | The size of each file | The body limit of the route |
| `maxTotalBytes` | The size of the whole multipart body | The body limit of the route |

The package also caps every part at 16 header lines and 16 KiB of headers, and every field name at 256 bytes. It accepts a boundary of 1 to 70 characters from the alphabet of RFC 2046 and answers 400 with the code `INVALID_MULTIPART` for any other boundary. It answers that 400 too for a part without a `form-data` disposition and a name, and for a body that ends before its closing boundary. The parser enforces every limit itself as the bytes arrive, so the package applies the route's body limit and the limits of the upload whatever length the client declares.

## A slow destination slows the client

While a destination is busy, the package stops reading the body, and once 64 KiB of the body wait unread, it pauses the uWebSockets.js socket. The kernel buffers of the connection then fill, and the client sends more slowly. When the destination accepts more, the package resumes the socket. An upload therefore takes no more memory when a disk or the network behind a destination falls behind.

uWebSockets.js stops its own idle timer while a socket is paused, so the package keeps a timer of its own and closes the connection when an upload stays paused for 10 seconds.

## What happens when an upload fails

When the client disconnects, when a limit trips, when the body breaks the multipart format, or when the handler passes its time limit, the package destroys every destination of the request. For a stream from `fs.createWriteStream()` with a path, it waits for the stream to close and then deletes the file. For a destination with a `discard` function, it calls that function. It deletes the files of the parts that had already finished too, because the request failed as a whole, so that you find files on disk from complete uploads alone. A time limit or a disconnect that comes after `multipart()` has resolved leaves the files in place. `multipart()` then rejects with the error, and the package closes the connection after the reply, because it stopped reading the body.

## Test an upload

Pass the multipart body to `app.request()` as a list of chunks. The tests of the package split each multipart body at every byte position, so that every test includes a boundary that falls across two chunks:

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
