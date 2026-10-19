## 0.1.0 (2026-10-19)

### 🚀 Features

- run middleware before functions without next ([8bed47b](https://github.com/assetcorp/uhttp/commit/8bed47b))
- publish prereleases to npm and add the benchmark suite ([e90c46e](https://github.com/assetcorp/uhttp/commit/e90c46e))
- add ten optional middleware with their own entry points ([a60ebee](https://github.com/assetcorp/uhttp/commit/a60ebee))
- stop worker threads that take too long to build their app ([e33088a](https://github.com/assetcorp/uhttp/commit/e33088a))
- serve HTTPS, reload certificates, and close servers gracefully ([8ece409](https://github.com/assetcorp/uhttp/commit/8ece409))
- serve WebSockets, worker threads, and pub/sub ([9a5900c](https://github.com/assetcorp/uhttp/commit/9a5900c))
- read the query string and content type on first use ([dfc3ae5](https://github.com/assetcorp/uhttp/commit/dfc3ae5))
- add request bodies, validation, and uploads ([6a26389](https://github.com/assetcorp/uhttp/commit/6a26389))
- add routing, middleware, and responses to the app ([6edaa96](https://github.com/assetcorp/uhttp/commit/6edaa96))
- add the uhttp package with speed checks ([3f0c8fb](https://github.com/assetcorp/uhttp/commit/3f0c8fb))

### 🩹 Fixes

- reject non-function before and handle in middleware ([3a56937](https://github.com/assetcorp/uhttp/commit/3a56937))
- wait for non-native thenables returned by before ([dea734c](https://github.com/assetcorp/uhttp/commit/dea734c))
- run the publish step as a dry run instead of skipping it ([9e322d2](https://github.com/assetcorp/uhttp/commit/9e322d2))
- count new keys when the rate-limit store is full ([831ab64](https://github.com/assetcorp/uhttp/commit/831ab64))
- close the connection after a 413 even when the handler catches it ([7afbff5](https://github.com/assetcorp/uhttp/commit/7afbff5))
- close the connection after a 413 for an oversized body ([814f552](https://github.com/assetcorp/uhttp/commit/814f552))
- close the connection after a rejected request body ([69ba772](https://github.com/assetcorp/uhttp/commit/69ba772))
- discard a rejected request body and keep the connection open ([046a079](https://github.com/assetcorp/uhttp/commit/046a079))
- drop headers of a reply that a later error reply replaces ([53494c4](https://github.com/assetcorp/uhttp/commit/53494c4))
- bound speed-guard startup fetch and fail on body mismatch ([4c7f61f](https://github.com/assetcorp/uhttp/commit/4c7f61f))

### ❤️ Thank You

- assetcorp