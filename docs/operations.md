# Operations

A production deployment platform has not been selected. Phase 2 launches Playwright-managed
Chromium locally for development and test purposes. Local Windows execution is not a production
isolation model.

Production browser-worker containers, databases, coordination services, and network isolation are
not implemented. Phase 3 provides application-level URL, hostname, DNS, address, and redirect
checks on Windows. These are defense in depth, not a production isolation boundary.

Public Internet navigation is enabled by default subject to content and SSRF policy. A production rollout must put non-root, sandboxed
Chromium workers behind a network policy that blocks private, host, metadata, and control-plane
networks independently of application behavior.

Phase 4 exposes `/ws/browser`. Tickets live for 30 seconds, are consumed once, and are sent only in
the initial WebSocket message. Native ping/pong checks run every 30 seconds. Disconnecting a viewer
does not destroy its browser session, so a fresh ticket can reconnect.

Monitor connections, frames received/sent/dropped, bytes, approximate FPS, resize frequency, and
cleanup failures. Never log frame bytes, tickets, query strings, cookies, page content, or
authorization material. Production requires HTTPS/WSS and authenticated same-site ticket issuance.

Phase 5 input is limited to 240 authenticated control events per second per connection. Pointer
moves are coalesced both at animation-frame cadence in the client and latest-wins in the service.
Disconnect, blur, crash, and session closure release held keys and mouse buttons. Operators should
monitor received, forwarded, coalesced, average-latency, and p95-latency input metrics.
