# Browser-control protocol

The wire protocol is intentionally deferred until the isolated browser-service proof of concept.
Phase 1 defines only a protocol version and nominal identifier types in `packages/protocol`.

Phase 3 adds `NavigateRequest`, `NavigateSuccess`, and structured navigation error codes, plus the
internal endpoint:

```text
POST /internal/browser-session/:sessionId/navigate
{ "url": "https://example.com" }
```

The service treats the URL as untrusted and sends it to Chromium only after policy approval. This
HTTP API remains the only navigation path.

## Phase 4 display transport

`POST /internal/browser-session/:sessionId/stream-ticket` issues a random, single-use ticket that
expires after 30 seconds. The client opens `/ws/browser` without secrets in the URL and sends a
versioned `stream.authenticate` JSON message first.

Allowed client events are `stream.authenticate`, `stream.ready`, `frame.ack`, `viewport.resize`,
and `session.ping`. Navigation and input events are rejected. Server events report authentication,
frame configuration, URL/title/loading changes, crashes, closure, and structured errors.

JPEG data uses binary messages. Its 20-byte big-endian header is ASCII `RBV1` (4), protocol version
(1), JPEG format code 1 (1), header length (2), sequence (4), width (4), and height (4), followed by
JPEG bytes. Images are never transported as JSON/base64.

## Phase 5 input messages

After authentication, version 1 accepts `input.pointerMove`, `input.pointerDown`,
`input.pointerUp`, `input.wheel`, `input.keyDown`, `input.keyUp`, `input.insertText`, `input.focus`,
and `input.blur`. Coordinates are Chromium CSS pixels for the currently displayed frame. Modifiers
use CDP bits: Alt 1, Control 2, Meta 4, Shift 8. Input messages contain no session identifier; the
server binds them to the ticket-authorized connection. Navigation remains forbidden over WebSocket.
