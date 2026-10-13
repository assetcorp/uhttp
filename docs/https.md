# Serve HTTPS

With the `tls` option, `serve()` serves HTTPS with a key and a certificate that the package loads from PEM files. You can serve several hostnames, each with a certificate of its own. You can also renew every certificate while the server goes on serving.

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp().get('/health', c => c.text('ok'))
const server = await serve({
  app,
  port: 443,
  tls: {
    keyFile: '/etc/letsencrypt/live/example.com/privkey.pem',
    certFile: '/etc/letsencrypt/live/example.com/fullchain.pem',
  },
})
```

Put the intermediate certificates after your certificate in `certFile`, so that a client can build the chain up to a root certificate in its trust store. When the key file is encrypted, pass its passphrase as `passphrase`.

## Serve several hostnames

During the TLS handshake, a client sends the hostname of the server in the Server Name Indication extension from section 3 of RFC 6066. Under `hostnames`, map each hostname to a key and a certificate of its own:

```ts
const server = await serve({
  app,
  port: 443,
  tls: {
    keyFile: '/etc/tls/example.com.key',
    certFile: '/etc/tls/example.com.crt',
    hostnames: {
      'api.example.com': { keyFile: '/etc/tls/api.example.com.key', certFile: '/etc/tls/api.example.com.crt' },
      '*.shop.example.com': { keyFile: '/etc/tls/shop.example.com.key', certFile: '/etc/tls/shop.example.com.crt' },
    },
  },
})
```

The server sends the certificate of a hostname to every client that sends that hostname, while it sends the certificate at the top level to every other client. A `*` stands for the first label of a hostname alone, so `*.shop.example.com` matches `eu.shop.example.com`. A client that sends `shop.example.com` or `a.eu.shop.example.com` therefore receives the certificate at the top level. When you list a hostname together with a wildcard that matches it, the server sends the certificate of the listed hostname to a client that sends that hostname.

The server serves the same routes under every hostname. `serve()` stores each hostname in lowercase, so `API.example.com` and `api.example.com` count as one hostname. `serve()` rejects with `INVALID_SERVE_OPTIONS` for a key that is not a hostname, for a hostname with more than 253 characters, and for a hostname that you list twice. It also rejects a hostname with more than 10 labels, because uWebSockets.js v20.71.0 matches no certificate to a hostname that long.

uWebSockets.js v20.71.0 matches the hostname from a client case-sensitively, although DNS hostnames are case-insensitive under section 3 of RFC 6066. A client that sends `API.example.com` therefore receives the certificate at the top level, even when you list `api.example.com`.

## Check the files at the start

Before it registers any certificate, `serve()` loads every key file and every certificate file and checks that each key decrypts with its passphrase and matches its certificate. When a check fails, `serve()` rejects with `INVALID_CERTIFICATE` and leaves the port unbound. The package checks every file first, because uWebSockets.js skips, without an error, a hostname whose files it fails to load.

## Renew the certificates

Once you replace the files, for example after Certbot renews them, call `server.reload()`:

```ts
process.on('SIGHUP', async () => {
  try {
    await server.reload()
  } catch (error) {
    console.error('The server goes on with its old certificates.', error)
  }
})
```

`server.reload()` loads and checks every file again, as `serve()` does. When a file fails the check, `server.reload()` rejects with `INVALID_CERTIFICATE`, while the server goes on serving with the old certificates. Otherwise, the server builds a new app of uWebSockets.js with the renewed certificates and sends every new connection to that app from then on.

The server then closes the old connections in the steps of `server.close()`, with one difference: it serves a new request on an old connection as usual, and then it closes that connection after the reply. For a WebSocket upgrade on an old connection, the server sends the 503 with the code `SERVER_CLOSING`, so that the client can open the socket on a new connection. The server closes every old WebSocket with the code 1001, so that its client can connect again and receive the renewed certificate.

Once no old request is in progress on a thread, the server closes the idle old connections of that thread. Then, once `gracePeriodMs` passes, it closes every old connection that is left. A client that sends a request on an idle old connection at the moment that the server closes it can see the connection reset. Under section 9.2.2 of RFC 9110, that client can then send an idempotent request such as a GET again on a new connection.

With worker threads, `server.reload()` starts a new worker for each old one and waits until every new worker serves. Only then does the main thread send the new connections to the new workers, while each old worker finishes the requests on its connections and exits. When a new worker fails to start, or takes longer than `workerStartTimeoutMs` to build its app, `server.reload()` rejects with `APP_START_FAILED`, while the old workers go on serving. The main thread also logs the error of that new worker.

A second call to `server.reload()` waits until the first one finishes. Once `server.close()` starts, `server.reload()` rejects with `SERVER_CLOSING`. On a server without `tls`, `server.reload()` rejects with `INVALID_SERVE_OPTIONS`.

## Limits of HTTPS in uWebSockets.js

For each hostname, uWebSockets.js v20.71.0 prints two lines to standard output when the package registers the routes under that hostname, such as 'finding api.example.com' and 'Browsed to SNI: api.example.com'. uWebSockets.js v20.71.0 has no option that turns those lines off.

With worker threads, the main thread sends a 503 in response to each request while no worker serves. On a server with `tls`, a client that receives that 503 gets the certificate at the top level that the main thread loaded at the start, because the main thread receives every connection on one listening socket that the package keeps open across reloads.
