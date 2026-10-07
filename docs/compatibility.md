# Compatibility

Deterministic compatibility and security tests use only `apps/test-site`. They cover approved pages,
same-origin redirects, blocked-content/private/scheme redirects, redirect loops, rendering, context
isolation, and lifecycle cleanup.

Public HTTP/S hosts are permitted by default when DNS returns only public addresses. Real-site
access is not part of deterministic CI, and no broad compatibility claim is made. The built-in
adult-host list is a baseline, not a comprehensive content-classification service.

Phase 4 targets the Playwright-pinned Chromium and browsers with binary WebSockets,
`ResizeObserver`, canvas, Blob, and `createImageBitmap`. CDP screencast can skip frames and vary its
cadence; it is an MVP display transport, not a final high-performance media architecture.

Remote input depends on Pointer Events and the host browser's keyboard event delivery. Browser- and
OS-owned shortcuts such as Ctrl+L, Ctrl+T, Ctrl+W, devtools shortcuts, Alt+Tab, and Windows-key
combinations may never reach the page. Event-provided plain-text paste is supported; continuous
clipboard synchronization and full IME composition are not.
