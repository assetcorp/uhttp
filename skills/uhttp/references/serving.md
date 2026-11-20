# Start, stop, HTTPS, and a proxy in front

## Listen and close

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp({ logger: console }).get('/health', c => c.text('ok'))
const server = await serve({ app, port: 3000, host: '127.0.0.1', gracePeriodMs: 20_000 })

async function shutDown() {
  await server.close()
}

process.once('SIGTERM', shutDown)
process.once('SIGINT', shutDown)
```

- Without `host`, the server listens on every interface. Pass `host: '127.0.0.1'` behind a proxy on the same machine.
- With `port: 0`, the operating system picks a free port, which `server.port` holds once `serve()` resolves. `serve()` rejects with `LISTEN_FAILED` when another server listens on the port, unless every server on that port sets `reusePort`.
- Pass `path` in place of `port` and `host` to listen on a Unix socket. uhttp sets the mode of the socket file to `0o600`, and `socketMode` changes it, such as to `0o660` for the group of the process.
- uhttp installs no signal handler, so the app closes the server from its handlers, as above, and closes its other resources, such as a database pool, after `server.close()` resolves.
- `server.close()` closes the listening socket and closes each WebSocket with the code 1001. It lets each request in progress finish within `gracePeriodMs`, which is 10 seconds by default, and answers each new request on an open connection with a 503 and the code `SERVER_CLOSING`. Set `gracePeriodMs` below the time that the process manager waits between its stop signal and `SIGKILL`.

## HTTPS

```ts
import { createApp, serve } from '@delali/uhttp'

const app = createApp({ logger: console }).get('/health', c => c.text('ok'))
const server = await serve({
  app,
  port: 8443,
  tls: {
    keyFile: '/etc/letsencrypt/live/shop.example.com/privkey.pem',
    certFile: '/etc/letsencrypt/live/shop.example.com/fullchain.pem',
  },
})

process.on('SIGHUP', async () => {
  try {
    await server.reload()
  } catch (error) {
    console.error('The server goes on with its old certificates.', error)
  }
})
```

- Put the intermediate certificates after the certificate in `certFile`, and pass `passphrase` for an encrypted key.
- `hostnames` maps each hostname that clients send through Server Name Indication to a separate `keyFile` and `certFile`, and `*` matches the first label alone.
- `serve()` loads every file and checks that each key matches its certificate, and it rejects with `INVALID_CERTIFICATE` and binds no port when a check fails.
- Once the files change on disk, such as after a renewal, `server.reload()` loads them again for new connections. When a file fails the check, `reload()` rejects with `INVALID_CERTIFICATE`, and the server goes on with the old certificates.
- uhttp serves HTTP/1.1 and WebSockets, because uWebSockets.js v20.71.0 has no HTTP/2 server. To give browsers HTTP/2, put a proxy in front.

## A proxy in front

uWebSockets.js v20.71.0 applies these limits to every connection, whatever options the app passes to uhttp:

| What uWebSockets.js does | What the proxy has to do |
| --- | --- |
| It closes a keep-alive connection after about 10 seconds without a request. | Close each idle connection to uhttp within 10 seconds. |
| It closes a connection, without a reply, when a body arrives at less than 16 KiB a second. | Read the whole body from the client before it forwards the request. |
| It answers 400 with an HTML body when the request line and the headers pass 4,096 bytes, unless `UWS_HTTP_MAX_HEADERS_SIZE` sets a larger limit before the process starts. | Forward no request with larger headers than that limit. |
| It answers 400 to every HTTP/1.0 request. | Send HTTP/1.1, including in its health checks. |
| It closes the connection without a reply when a request arrives while the reply to an earlier request on that connection is pending. | Send each request after the response to the previous one. |

This nginx configuration stays inside those limits, accepts HTTP/2 over TLS, passes WebSocket upgrades on, and removes the `uWebSockets: 20` header that tells a client which server software the app uses:

```nginx
upstream uhttp {
    server 127.0.0.1:3000;
    keepalive 32;
    keepalive_timeout 5s;
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      '';
}

server {
    listen 443 ssl;
    http2 on;
    server_name shop.example.com;

    ssl_certificate     /etc/ssl/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/shop.example.com/privkey.pem;

    location / {
        proxy_pass http://uhttp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering on;
        proxy_read_timeout 150s;
        proxy_hide_header uWebSockets;
    }
}
```

- Keep `proxy_read_timeout` above the longest `idleTimeoutMs` of the WebSocket routes, which is 2 minutes by default, so that nginx keeps an idle socket open.
- In HAProxy, send the health check with `ver HTTP/1.1` and a `host` header, as in `http-check send meth GET uri /health ver HTTP/1.1 hdr host shop.example.com`, against a GET route that answers 200.
- Add `trustedProxies()` with the address of the proxy, as [middleware.md](middleware.md) shows, so that the app reads the address and the protocol of each client from the headers that the proxy sets.
