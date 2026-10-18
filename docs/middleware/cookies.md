# Cookies

Use the cookie helpers to read the cookies of a request, to set and delete cookies on the response, and to sign a cookie, so that `getSignedCookie()` returns `undefined` for a cookie that the client changed. Add `cookies()` to every route on which you read cookies, because the middleware declares the `Cookie` header for those routes.

```ts
import { createApp } from '@delali/uhttp'
import { cookies, deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from '@delali/uhttp/cookies'

const app = createApp()
  .use(cookies({ keys: [process.env.COOKIE_KEY ?? ''] }))
  .get('/', c => c.text(`Theme: ${getCookie(c, 'theme') ?? 'light'}`))
  .post('/sign-in', async c => {
    const user = await signIn(c)
    setSignedCookie(c, 'session', user.id, { maxAge: 7 * 24 * 60 * 60 })
    setCookie(c, 'theme', user.theme, { httpOnly: false })
    return c.json({ signedIn: true })
  })
  .post('/sign-out', c => {
    deleteCookie(c, 'session')
    return c.json({ signedIn: false })
  })
```

## Read cookies

`getCookie(c, name)` returns the value of a cookie without surrounding quotes, or `undefined` when the client sent no cookie with that name. The helpers parse the `Cookie` header the first time that you read a cookie, across every `Cookie` line that the client sent. When a client sends one name twice, `getCookie()` returns the first value, which a browser sends for the cookie with the most specific path.

## Set and delete cookies

`setCookie(c, name, value, options)` adds one `Set-Cookie` line to the response. The helper sets `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/` on every cookie unless you change them:

| Option | Meaning |
| --- | --- |
| `domain` | The browser sends the cookie to this domain and its subdomains. Without it, the browser sends the cookie only to the host that set it. |
| `path` | The browser sends the cookie to the paths under this one, which is `/` by default. |
| `maxAge` | The browser keeps the cookie for this many whole seconds, up to 400 days. |
| `expires` | The browser keeps the cookie until this date. |
| `httpOnly` | When this is `true`, which is the default, the browser hides the cookie from the scripts of the page. |
| `secure` | When this is `true`, which is the default, the browser sends the cookie only over HTTPS. |
| `sameSite` | With `Strict`, `Lax`, or `None`, you choose whether the browser sends the cookie with requests from other sites. |
| `partitioned` | When this is `true`, the browser keeps a separate copy of the cookie for each top-level site. |

The helper sends the value as you pass it, so encode a value that can contain characters outside the cookie alphabet, with `encodeURIComponent()` for example. The helper throws a `UhttpError` with the code `INVALID_COOKIE` for a name that is not an HTTP token, for a value or an attribute with `;` or a control character, for a name and a value above 4,096 bytes together, or for a `maxAge` above 400 days. It also throws for `SameSite=None` or `partitioned` without `Secure`, and for a name that starts with `__Secure-` or `__Host-`, in any case, unless the attributes of the cookie meet the rules that browsers apply to that prefix.

`deleteCookie(c, name, options)` sets the cookie again with an empty value, `Max-Age=0`, and an expiry in 1970. Pass the same `path` and `domain` that you used to set the cookie, because a browser keeps a cookie whose path or domain differs.

## Sign a cookie

`setSignedCookie()` appends an HMAC-SHA-256 signature to the value. `getSignedCookie()` returns the value when the package can verify the signature with one of your keys, and `undefined` for any other cookie. The package signs the name together with the value, so it accepts a signed value only under the name that it signed the value with. The package compares signatures in constant time. It signs the value without encrypting it, so the client can still read the value. Keep secrets out of a signed cookie.

Pass each key to `cookies()` as a string or as bytes of at least 20 bytes. `cookies()` throws `INVALID_MIDDLEWARE_OPTIONS` for a shorter key, so the call to `cookies()` in the first example throws at startup when `COOKIE_KEY` is unset. The package signs every new cookie with the first key and verifies signatures with every key, so that you can rotate keys: put the new key at the front of the list, and drop the oldest key once every cookie that the package signed with it has expired.

```ts
app.use(cookies({ keys: [process.env.COOKIE_KEY_2026, process.env.COOKIE_KEY_2025].filter(key => key !== undefined) }))
```

## Sign-in through a form post from another site

Some sign-in providers return their response to your app in a form that the browser posts from the site of the provider. The OpenID Foundation calls this the [form post response mode](https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html), and OpenID Connect providers such as Microsoft Entra ID offer it. A browser leaves a `SameSite=Lax` cookie off that cross-site post, so set the cookie that stores the state of the sign-in with `sameSite: 'None'`, and leave `secure` at its default of `true`, which `SameSite=None` requires:

```ts
setSignedCookie(c, 'sign-in-state', state, { sameSite: 'None', maxAge: 600, path: '/auth/callback' })
```

Name the origin of the provider in the `origin` option of [`csrf()`](csrf.md) as well, so that the CSRF middleware allows that post.

## Safari on plain-HTTP localhost

Chrome and Firefox store a `Secure` cookie from `http://localhost`, while Safari drops it, as the WebKit team tracks in [bug 232088](https://bugs.webkit.org/show_bug.cgi?id=232088). When you develop with Safari, serve your app over HTTPS on your machine with the steps in [Serve HTTPS](../https.md), or pass `secure: false` in development alone.
