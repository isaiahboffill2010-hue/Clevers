# ADR 0004: Live display-only remote viewport

- Status: Accepted
- Date: 2026-10-06

## Decision

Phase 4 uses `Page.startScreencast` through a CDP session attached to the existing Playwright page.
The service decodes CDP base64 once and emits binary WebSocket frames with a fixed 20-byte header.
JPEG quality 70, maximum 1280x720, every frame, and DPR 1 are MVP configuration constants.

The WebSocket is authorized by a random 256-bit, 30-second, single-use ticket bound server-side to
one session. The ticket is sent in the initial authentication message, not the URL. Only display
lifecycle, heartbeat, acknowledgement, and bounded resize controls are accepted. Navigation stays
on the Phase 3 policy-enforced HTTP endpoint.

Backpressure is latest-wins: one send may be in flight and at most one pending frame is retained.
A newer pending frame replaces the old one. CDP frames are acknowledged promptly after safe decode.

The React viewport parses each header, creates an `ImageBitmap`, paints a canvas, and immediately
closes the bitmap. A 150 ms `ResizeObserver` debounce sends dimensions from 320x240 to 1920x1080.

## Consequences

CDP screencast offers a small MVP surface and real rendered pixels, but no stable frame rate. It can
drop or coalesce frames and costs more bandwidth than a modern video codec. A future media path may
use hardware encoding or WebRTC. Phase 4 deliberately provides no remote input.
