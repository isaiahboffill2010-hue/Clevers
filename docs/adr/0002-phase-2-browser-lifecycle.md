# ADR 0002: Phase 2 browser lifecycle proof

- Status: Accepted
- Date: 2026-10-06

## Decision

The standalone browser service owns one lazily launched Playwright-managed Chromium instance. For
Phase 2 it permits at most one non-persistent `BrowserContext`, containing exactly one `Page`, and
navigates only to an operator-configured controlled test-site URL.

Screenshots are held in memory only long enough to verify a valid PNG was rendered. The service
returns metadata, never image bytes or filesystem paths. Session IDs use Node's cryptographically
strong UUID generator.

## Consequences

This proves lifecycle, isolation, rendering, crash observation, and cleanup without establishing a
public browsing proxy. It deliberately provides no arbitrary navigation, streaming, input control,
persistence, or production network isolation. Phase 3 remains responsible for SSRF and egress
controls.
