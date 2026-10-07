# ADR 0005: Raw remote input forwarding

- Status: Accepted
- Date: 2026-10-06

## Decision

Phase 5 forwards physical browser input through the authenticated Phase 4 WebSocket to a dedicated
per-session controller using CDP `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and
`Input.insertText`. It never locates or manipulates remote DOM nodes.

The frontend maps client coordinates through the contain-fit frame rectangle. It accounts for
letterboxing, container size, frame dimensions, resizing, and DPR 1; points outside the rendered
image are ignored. Pointer moves are animation-frame coalesced while button, wheel, and key events
are immediate.

Physical key transitions are dispatched separately from committed printable text. Printable keys,
event-provided paste text, and completed composition text use `Input.insertText` to avoid layout
assumptions. Full IME composition state is deferred.

Clicking the viewport establishes explicit focus. Blur, disconnect, crash, or cleanup releases all
held keys and buttons. `Ctrl+Alt+Shift+Escape` is reserved locally to release capture and is never
forwarded. Host-browser and operating-system shortcuts cannot be guaranteed.

## Consequences

Input remains bound to the stream-authorized session and cannot navigate. The Phase 3 SSRF policy and
ephemeral BrowserContext model are unchanged. Phase 6 may improve browser chrome, but must retain
these protocol and cleanup boundaries.
