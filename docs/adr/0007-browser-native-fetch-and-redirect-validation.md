# ADR 0007: Browser-native fetching with response-stage redirect validation

- Status: Accepted
- Date: 2026-10-06

## Context

The browser route previously used Playwright `route.fetch()` and `route.fulfill()` for every main
document. This made the browser service, rather than Chromium's network stack, obtain the document.
Most sites tolerated that distinction, but ChatGPT returned a different unauthenticated fallback;
its CSS and JavaScript requests then returned HTTP 403. Direct headless Chromium instead received
ChatGPT's Cloudflare challenge response.

## Decision

Chromium now performs requests without response substitution. A CDP Fetch response-stage pause
inspects document redirects and validates a relative or absolute `Location` before Chromium may
continue. Browser-context routing still validates every observable HTTP/S request before it starts.
Page-created WebSockets have a separate route and accept only public `ws:`/`wss:` destinations that
pass the same DNS, IP, port, internal-hostname, and adult-domain rules. User top-level navigation
continues to accept only HTTP/S.

Browser-created `blob:`, `data:`, and `about:` resources are non-network resources and are not sent
through destination validation. User-entered URLs with those schemes remain blocked. Service
workers are disabled because their intercepted traffic cannot be comprehensively enforced by the
Playwright route boundary.

## Consequences

Normal sites receive browser-native request and response behavior, and redirect validation no
longer changes response identity or headers. ChatGPT still challenges headless Chromium; this is a
site-side environment decision and is not bypassed. Production continues to require network-level
egress enforcement because application interception is defense in depth rather than a complete
network sandbox.
