# Trusted proxies

When a proxy or a load balancer forwards requests to your server, the proxy opens every connection that your server accepts, so the address of each connection is the address of the proxy. The middleware that `trustedProxies()` returns takes the address, the protocol, and the host of the client from the forwarding headers that the proxies on your list send. When any other peer sends those headers, the middleware ignores them.

```ts
import { createApp } from '@delali/uhttp'
import { clientAddressOf, hostOf, protocolOf, trustedProxies } from '@delali/uhttp/trusted-proxies'

const app = createApp()
  .use(trustedProxies({ trust: ['10.0.0.0/8'] }))
  .get('/where', { headers: ['host'] }, c =>
    c.json({ address: clientAddressOf(c), protocol: protocolOf(c), host: hostOf(c) }),
  )
```

## Name your proxies

List your proxies in the `trust` option as addresses such as `10.0.0.5` or `::1`, as CIDR ranges such as `10.0.0.0/8` or `fd00::/8`, and as the word `unix` for a proxy that connects over a Unix socket. The list is empty by default, so the package treats no peer as a proxy until you add it to the list. `trustedProxies()` throws a `UhttpError` with the code `INVALID_MIDDLEWARE_OPTIONS` for a hop count such as `1` and for `true`, because a client can add its own entries to `X-Forwarded-For`, which a hop count or `true` can lead the package to take as the address of the client.

## How the package finds the client

When the peer that sent a request is on the list, the package parses `X-Forwarded-For`, across every line of the header, and checks its entries from right to left. The package skips each address that is on the list, so it takes the first address outside the list as the address of the client. A client can write any entries at the left of the header. However, each proxy on the list appends the address of the peer that connected to it, so the package stops before it gets to the entries that the client wrote:

```
X-Forwarded-For: 198.51.100.66, 203.0.113.7, 10.0.0.2
```

With `trust: ['10.0.0.0/8']`, the package takes `203.0.113.7` as the address of the client of that request, while it ignores `198.51.100.66`, because the client can write that entry itself. When the package finds an entry that is not an address, it stops and uses the nearest valid address that it found before that entry. The package canonicalises every address before it compares it, so `::ffff:10.0.0.1` matches `10.0.0.1`. It also drops the zone ID of an IPv6 address, such as `%eth0`.

The package takes the protocol from the last entry of `X-Forwarded-Proto` when that entry is `http` or `https`. It takes the host from the last entry of `X-Forwarded-Host` when that entry is a valid host name or IP address, with or without a port. The package ignores the `Forwarded` header of RFC 7239.

When a peer outside the list sends `X-Forwarded-For`, the package uses the address of the peer. The first time that this happens, the package also writes a warning to the logger of the app, so that you can add the peer to the list when it is one of your proxies.

## Read the client

`clientAddressOf(c)` returns the address of the client in canonical form, such as `203.0.113.7` or `2001:db8::1`. For a client on a Unix socket, the function returns the empty string.

`protocolOf(c)` returns `http` or `https`. Without a trusted proxy that reports a protocol, the function returns `https` on a TLS connection, where `c.req.secure` is `true`, and `http` on any other connection.

`hostOf(c)` returns the host in lowercase, which can end with a port. Without a trusted proxy that reports a host, the function takes the host from the `Host` header, so declare `host` on the route or on one of its middleware, as the example above does. Read [Routing and middleware](../routing.md) to learn why the package copies only the headers that your code declares.

Add `trustedProxies()` before every middleware that uses the address, the protocol, or the host of the client, such as `rateLimit()`, `requestId()`, `accessLog()`, `secureHeaders()`, and `csrf()`. Without `trustedProxies()`, those middleware use the address of the socket and the `Host` header, while `requestId()` generates a new ID for every request.
