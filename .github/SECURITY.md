# Security policy

## Supported versions

uhttp is pre-1.0 and under active development. Security fixes go into the latest `0.x` release on npm. Upgrade to the latest version before you report a problem, in case a fix already exists.

## Reporting a vulnerability

Report security issues privately through GitHub. Open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to [the advisory form](https://github.com/assetcorp/uhttp/security/advisories/new). The advisory keeps the report private until a fix is ready.

Report a security problem through the advisory alone, and wait for the fix to reach npm before you discuss the problem in public.

Include as much as you can.

- Name the affected version of `@delali/uhttp`, the Node.js version, and the uWebSockets.js version.
- Say which part the problem is in: routing and middleware, request bodies and uploads, responses and headers, WebSockets, or worker threads.
- Give the steps to reproduce, and a proof of concept if you have one.
- Describe the impact that you expect, such as a crash, memory exhaustion, a bypassed check, or information disclosure.

## What to expect

The maintainer will acknowledge your report. Once the maintainer confirms the issue, a fix and a coordinated disclosure will follow.
