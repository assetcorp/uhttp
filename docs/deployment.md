# Deploy behind a proxy

uhttp serves HTTP/1.1 and WebSockets, because uWebSockets.js v20.71.0 has no HTTP/2 server in its API. To serve HTTP/2 to browsers, put a reverse proxy such as nginx or HAProxy in front of uhttp, so that the proxy speaks HTTP/2 to each client and HTTP/1.1 to uhttp. uWebSockets.js also applies several limits to each connection in its native code. A proxy that crosses one of those limits can lose requests, so you have to set the proxy for each of them.

## The limits of uWebSockets.js

uWebSockets.js v20.71.0 applies each of these limits whatever options you pass to uhttp:

| Limit | What uWebSockets.js does | What the proxy has to do |
| --- | --- | --- |
| Idle keep-alive connection | It closes a connection after 10 seconds without a request. | The proxy closes each idle connection to uhttp within 10 seconds. |
| Upload rate | It resets its 10-second timer only after each 160 KiB of a body, so it closes, without a reply, a connection whose body arrives at less than 16 KiB a second. | The proxy reads the whole body from the client before it sends the request to uhttp. |
| Size of the request line and headers | It answers 400 with an HTML body when the request line and the headers take more than 4,096 bytes. | The proxy forwards no request whose request line and headers take more than `UWS_HTTP_MAX_HEADERS_SIZE`, which is 4,096 bytes unless you set it. |
| HTTP/1.0 | It answers 400 to every HTTP/1.0 request. | The proxy sends HTTP/1.1, including in its health checks. |
| Pipelining | When a request arrives while the reply to an earlier request on the same connection is pending, it closes the connection without a reply to either request. | The proxy sends each request only after the response to the previous request on that connection. |

uWebSockets.js adds the headers `Date` and `uWebSockets: 20` to every response. From the second header, a client can learn which server software you use, so in each configuration below, the proxy removes that header.

You can find every request to which uWebSockets.js answers 400 itself, before it calls uhttp, in [Errors](errors.md#errors-that-uwebsocketsjs-sends-itself).

## nginx

With this configuration, nginx accepts HTTP/2 from clients over TLS and keeps up to 32 idle connections to uhttp, each for 5 seconds at most:

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

Through these directives, nginx stays inside the limits of uWebSockets.js:

- With `keepalive_timeout 5s`, nginx closes an idle connection to uhttp after 5 seconds. The default is 60 seconds, so without the directive, nginx can send a request on a connection at the moment that uWebSockets.js closes it.
- With `proxy_http_version 1.1`, nginx sends HTTP/1.1 to uhttp. nginx 1.29.7 and later send HTTP/1.1 by default, while earlier versions send HTTP/1.0, which uWebSockets.js rejects with a 400.
- Through the map, nginx sends `Connection: upgrade` with a WebSocket upgrade request. For any other request, the map yields an empty value. Because nginx leaves out a header whose value is empty, it then sends no `Connection` header, so that it can keep the connection to uhttp open after the response.
- Under `proxy_request_buffering on`, which is the default, nginx reads the whole body from the client before it sends the request to uhttp, so nginx sends a slow upload to uhttp at the speed of the local network.
- With `proxy_read_timeout 150s`, nginx keeps an idle WebSocket open. By default, nginx closes a proxied connection after 60 seconds in which uhttp sends nothing, while uWebSockets.js sends its ping between 4 and 16 seconds before the `idleTimeoutMs` of the route, which is 2 minutes by default. Keep this value above the longest `idleTimeoutMs` of your WebSocket routes.
- With `proxy_hide_header uWebSockets`, nginx removes the `uWebSockets: 20` header from each response.

By default, nginx limits the request line and each header line to one buffer of 8 KiB, under `large_client_header_buffers 4 8k`, so it can forward a request whose headers add up to more than 4,096 bytes. To accept such a request, raise the limit of uWebSockets.js with `UWS_HTTP_MAX_HEADERS_SIZE`, under [Raise the header limit](#raise-the-header-limit).

When you list the address of nginx in the `trust` option of [Trusted proxies](middleware/trusted-proxies.md), uhttp takes the address of the client and the protocol from the `X-Forwarded-For` and `X-Forwarded-Proto` headers that nginx sets.

## HAProxy

With this configuration, HAProxy accepts HTTP/2 over TLS and checks the health of uhttp over HTTP/1.1:

```haproxy
frontend web
    mode http
    bind :443 ssl crt /etc/haproxy/certs/shop.example.com.pem alpn h2,http/1.1
    http-response del-header uWebSockets
    default_backend uhttp

backend uhttp
    mode http
    option httpchk
    http-check send meth GET uri /health ver HTTP/1.1 hdr host shop.example.com
    http-check expect status 200
    server app1 127.0.0.1:3000 check pool-purge-delay 4s
```

Without `ver HTTP/1.1`, HAProxy sends its health check over HTTP/1.0, which uWebSockets.js rejects with a 400, so HAProxy will mark every server as down. HTTP/1.1 requires a `Host` header, which `hdr host` adds. HAProxy sends `OPTIONS` by default, while uhttp answers 204 to OPTIONS only for a path that has routes, so in this configuration, HAProxy sends a GET to a route that returns 200, such as this one:

```ts
app.get('/health', c => c.text('ok'))
```

HAProxy differs from nginx on two of the limits:

- HAProxy closes half of the idle connections to a server every `pool-purge-delay`, which is 5 seconds by default, so an idle connection can stay open for longer than 10 seconds. With a lower `pool-purge-delay`, such as the 4 seconds in this configuration, HAProxy closes idle connections sooner.
- With `option http-buffer-request`, HAProxy waits for the whole body or for a full request buffer, which is 16 KiB under the default `tune.bufsize`. HAProxy therefore sends the rest of a larger body to uhttp at the speed of the client, so uWebSockets.js can close the connection of a client that uploads more slowly than 16 KiB a second.

In its default keep-alive mode, according to its manual, HAProxy processes each request and its response in turn on a connection, so HAProxy sends uhttp no pipelined requests.

## Raise the header limit

uWebSockets.js reads `UWS_HTTP_MAX_HEADERS_SIZE` once, when Node.js loads it, so set the variable in the environment of the process before the process starts:

```bash
UWS_HTTP_MAX_HEADERS_SIZE=16384 node server.js
```

Set the variable to the largest size of request line and headers that your proxy forwards, together with the headers that the proxy adds, such as `X-Forwarded-For`. uWebSockets.js answers 400 to a request above the limit in place of the 431 of [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html#section-5), because its maintainers commented out the 431 in [the parser source](https://github.com/uNetworking/uWebSockets/blob/1d80f7a53816ef2433e89793b285b827f3efb2b2/src/HttpParser.h). `app.request()` applies the same limit, so that `app.request()` returns the same 400 in a test as a client receives from the server.
