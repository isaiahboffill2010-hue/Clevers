# ADR 0003: Navigation SSRF security

- Status: Accepted
- Date: 2026-10-06

## Decision

Phase 3 originally accepted navigation targets only through an explicit hostname allowlist. ADR
0006 supersedes that admission rule while retaining every SSRF control below. The WHATWG URL
parser normalizes input; only HTTP and HTTPS are allowed; credentials and non-standard public ports
are rejected. Every DNS answer is classified, and any non-public answer rejects the navigation.

The controlled local fixture is a development-only exception bound to its exact protocol,
`127.0.0.1` host, and configured port. Loopback is not globally trusted.

Main-frame redirect responses are fetched without following the redirect. Their `Location` target
is validated before being fulfilled to Chromium. Browser-context routing revalidates subsequent
requests as defense in depth.

## Limits

Application validation cannot guarantee that Chromium connects to the same IP address that Node
resolved. It also cannot contain a compromised renderer. Production therefore still requires a
non-root, sandboxed Linux browser worker in a restricted network namespace with controlled DNS and
egress proxy enforcement.
