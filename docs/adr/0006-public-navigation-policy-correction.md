# ADR 0006: Public-by-default navigation with content blocking

- Status: Accepted
- Date: 2026-10-06

## Decision

Public HTTP and HTTPS navigation is allowed by default. A configurable hostname list blocks known
adult destinations by exact domain and subdomain boundary. This supersedes only the explicit public
hostname allowlist in ADR 0003.

The Phase 3 security boundary remains intact: credentials and unsafe schemes or ports are rejected;
literal IPs and every DNS answer are classified; private, loopback, link-local, reserved, and other
non-public addresses are denied; internal hostname forms are denied; redirects and browser-context
requests are revalidated. The exact local development fixture remains the sole private-address
exception.

## Consequences

A static hostname list is deliberately an enforcement hook, not a claim of comprehensive adult
content detection. It cannot classify individual paths on mixed-content platforms or immediately
cover new and changing domains. Production deployments should populate `NAVIGATION_BLOCKED_HOSTS`
from a maintained category source or enforce an equivalent category policy at a controlled DNS or
egress proxy. Network isolation is still required because application DNS validation does not pin
Chromium's eventual connection.

The authenticated streaming and remote-input protocols are unaffected.
