# Vercel hybrid deployment

## Decision

Deploy `apps/web` to Vercel and run `apps/browser-service` as a single-instance, always-on
container service on a host intended for stateful WebSockets and long-lived Chromium processes.
Do not deploy `apps/test-site`.

The browser service owns in-memory Chromium, BrowserContext, session, ticket, input, and WebSocket
state. Vercel Functions can place related HTTP and WebSocket requests on different instances, close
WebSockets at the maximum function duration, and scale instances to zero. A container image on
Vercel inherits those function semantics, so packaging Chromium in `Dockerfile.vercel` would not
make the current lifecycle reliable.

## Vercel

Import the repository root, select the **Services** framework, and use the committed `vercel.json`.
Only the `web` service is exposed by the catch-all rewrite. Configure:

- `NEXT_PUBLIC_BROWSER_SERVICE_HTTP`: public HTTPS origin of the external browser service.
- `NEXT_PUBLIC_BROWSER_SERVICE_WS`: public WSS origin of the same service.
- `NEXT_PUBLIC_BROWSER_INITIAL_URL`: initial public HTTP/S page, such as `https://example.com/`.

These values are embedded in the browser bundle and are not secrets.

## Browser worker

Use an always-on container host such as Render, Fly.io, Railway, AWS ECS/Fargate, Google Cloud Run
with minimum instances and session affinity, or a dedicated VM. For the current in-memory design,
run exactly one instance. The platform must support WebSocket upgrades, Chromium dependencies,
graceful termination, and a writable temporary directory. Install the Playwright-pinned Chromium
during the image build and keep the Chromium sandbox enabled.

Configure `HOST=0.0.0.0`, the platform-provided `PORT`, and
`BROWSER_SERVICE_ALLOWED_ORIGINS` with the exact Vercel production and preview origins that may
call the worker. Set `ENABLE_LOCAL_TEST_TARGET=false`; do not deploy the test fixture or configure
its loopback URL in production.

Horizontal scaling requires redesign: externalize session placement and tickets, route every HTTP
and WebSocket operation to the instance that owns its Chromium process, and implement reconnect or
session-recovery semantics. A Redis record alone cannot move a live Chromium process between
instances.
