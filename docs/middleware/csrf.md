# CSRF protection

When a page on another site sends a form to your app, the browser attaches the cookies of your site to that form. Without a check, your app will treat that form as a request from the signed-in user, which is a cross-site request forgery. The middleware that `csrf()` returns rejects such a form with a 403, so the package never calls the handler for it.

```ts
import { createApp } from '@delali/uhttp'
import { csrf } from '@delali/uhttp/csrf'

const app = createApp()
  .use(csrf())
  .post('/account/email', async c => c.json(await changeEmail(c)))
```

## What the middleware checks

The middleware checks every request whose method is other than GET, HEAD, OPTIONS, and TRACE, and whose content type a browser can send from a form without a preflight request: `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain`. It treats a request without a content type, or with a malformed one, as `text/plain`. A browser sends a JSON body to another origin only after a CORS preflight that [`cors()`](cors.md) allows, so the middleware lets such a request through.

For each request that it checks, the middleware uses two headers that a browser sets and that a script on the page can't change:

1. When `Sec-Fetch-Site` is `same-origin` or `none`, the middleware allows the request. A browser sends `none` when the user starts the request, such as from a bookmark.
2. When `Sec-Fetch-Site` has any other value, such as `cross-site` or `same-site`, the middleware allows the request only from an origin that you name in the `origin` option.
3. When the request has no `Sec-Fetch-Site`, as from an older browser, the middleware compares `Origin` with the origin of your app, or with the origins that you name.
4. The middleware rejects a request that has neither header.

The package replies to a rejected request with a 403 and the code `CSRF_REJECTED`. Read the [Fetch Metadata guide on web.dev](https://web.dev/articles/fetch-metadata) to learn what each value of `Sec-Fetch-Site` means.

## The origin of your app

Without the `origin` option, the middleware builds the origin of your app from the protocol and the host of each request, without the default port, as in `https://shop.example`. Behind a proxy, the middleware takes the protocol and the host from `trustedProxies()`, so add `trustedProxies()` before `csrf()`:

```ts
import { trustedProxies } from '@delali/uhttp/trusted-proxies'

app.use(trustedProxies({ trust: ['10.0.0.0/8'] })).use(csrf())
```

## Allow another site

Name the sites that may send forms to your app in `origin`, such as the site of a payment provider that posts its result back. Set `origin` to one origin, to a list of origins, or to a function, which can be async, that returns `true` for an allowed origin:

```ts
app.use(csrf({ origin: ['https://shop.example', 'https://pay.example'] }))
```

`csrf()` throws `INVALID_MIDDLEWARE_OPTIONS` for `*` and for `null`, because `*` matches every page, while any page can send a form with the origin `null`, from a sandboxed frame for example. When you name origins, the middleware allows a request without `Sec-Fetch-Site` only from an origin in your list, so include the origin of your app in the list for the browsers that send no `Sec-Fetch-Site`.
