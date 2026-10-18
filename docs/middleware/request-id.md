# Request IDs

The middleware that `requestId()` returns assigns an ID to each request and sends that ID back in the `X-Request-Id` header, so that a client can quote the ID of a failed request and you can find the request in your logs.

```ts
import { createApp } from '@delali/uhttp'
import { requestId, requestIdOf } from '@delali/uhttp/request-id'

const app = createApp()
  .use(requestId())
  .get('/orders/:id', c => {
    logger.info({ requestId: requestIdOf(c) }, 'The shop looked up an order.')
    return c.json({ id: c.req.param('id') })
  })
```

The package generates each ID with `crypto.randomUUID()`, as in `9b2f6a4e-3c1d-4e8f-a0b2-7d5c9e1f3a64`. `requestIdOf(c)` returns the ID, or `undefined` on a route that `requestId()` doesn't wrap. The middleware sets `X-Request-Id` before it calls the rest of the chain, so the package sends the header with an error reply as well as with the reply of your handler.

## Keep the ID that your proxy sends

A load balancer can assign an ID to each request before it forwards the request to your server, so that you can find the same request in the logs of the proxy and of the app by one ID. The package keeps an inbound `X-Request-Id` only when `trustedProxies()` trusts the peer that sent it, and only when the ID consists of 1 to 255 characters from `A-Z`, `a-z`, `0-9`, `_`, `=`, and `-`:

```ts
import { requestId } from '@delali/uhttp/request-id'
import { trustedProxies } from '@delali/uhttp/trusted-proxies'

app.use(trustedProxies({ trust: ['10.0.0.0/8'] })).use(requestId())
```

For every other request, the package generates a new ID, so your logs contain only the IDs that the package generated or that your proxy sent in those characters. Read [Trusted proxies](trusted-proxies.md) to learn how to list your proxies.
