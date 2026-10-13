# Serve HTTPS

With the `tls` option, `serve()` serves HTTPS with a key and a certificate that the package reads from PEM files. You can serve several hostnames, each with its own certificate, and renew every certificate while the server goes on serving.

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

Put the intermediate certificates after your certificate in `certFile`, so that a client can build the chain to a root certificate that it trusts. When the key file is encrypted, pass its passphrase as `passphrase`.

## Serve several hostnames

A client sends the hostname that it wants during the TLS handshake, in the Server Name Indication extension that RFC 6066 defines. Under `hostnames`, map each hostname to a key and a certificate of its own:

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

The server sends the certificate under a hostname to every client that names that hostname, and the certificate at the top level to every other client. A `*` stands for the first label of a hostname, so `*.shop.example.com` matches `eu.shop.example.com`, while a client that names `shop.example.com` or `a.eu.shop.example.com` receives the certificate at the top level. When a client names a hostname that you list as well as a wildcard that matches it, the server sends the certificate of the hostname that you listed.

The server serves the same routes under every hostname. `serve()` stores each hostname in lowercase, and it throws `INVALID_SERVE_OPTIONS` for a key that is not a hostname, for a hostname with more than 10 labels or more than 253 characters, and for a hostname that you list twice.

## Check the files at the start

Before it registers any certificate, `serve()` reads every key file and every certificate file, and it checks that each key decrypts with its passphrase and matches its certificate. When a check fails, `serve()` rejects with `INVALID_CERTIFICATE` and leaves the port unbound. The package checks every file first, because uWebSockets.js skips a hostname whose files it can't use and reports no error.

## Renew the certificates

Once you have replaced the files, such as after Certbot has renewed them, call `server.reload()`:

```ts
process.on('SIGHUP', async () => {
  try {
    await server.reload()
  } catch (error) {
    console.error('The server goes on with its old certificates.', error)
  }
})
```

`server.reload()` reads and checks every file again, as `serve()` does. When a file fails the check, it rejects with `INVALID_CERTIFICATE`, and the server goes on serving with the old certificates. Otherwise, the server builds a new app of uWebSockets.js with the renewed certificates, and it sends every new connection to that app from then on.

The server then retires the old connections as `server.close()` does, with one difference: the server answers a new request on an old connection as usual, and it closes the connection after the reply. The server still answers a WebSocket upgrade on an old connection with the 503 and the code `SERVER_CLOSING`, so that the client opens the socket on a new connection. The server closes every old WebSocket with the code 1001, so that its client can connect again and receive the renewed certificate. Once no old request is in progress, the server closes the idle old connections, and once `gracePeriodMs` has passed, it closes every old connection that is left. A client that sends a request on an idle old connection as the server closes it can see the connection reset, and RFC 9112 lets a client send an idempotent request such as a GET again in that case.

With worker threads, `server.reload()` starts a new worker for each old one and waits until every new worker serves. Only then does the main thread send the new connections to the new workers, while each old worker finishes its connections and exits. When a new worker fails to start, `server.reload()` rejects with `APP_START_FAILED`, and the old workers go on serving.

A second call to `server.reload()` waits until the first one has finished. Once `server.close()` has started, `server.reload()` rejects with `SERVER_CLOSING`, and on a server without `tls`, it rejects with `INVALID_SERVE_OPTIONS`.

## Limits of HTTPS in uWebSockets.js

uWebSockets.js prints two lines, such as 'finding api.example.com' and 'Browsed to SNI: api.example.com', to standard output for each hostname when the package registers the routes under it, and the package has no way to turn those lines off.

With worker threads, the main thread answers each request with a 503 while no worker serves. It answers with the certificate at the top level that it read at the start, because it accepts every connection on one listening socket, which the package keeps open through every reload.
