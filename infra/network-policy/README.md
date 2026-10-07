# Network policy

# Production network-policy target

Phase 3 does not install or emulate this policy on the Windows development machine.

```text
Browser worker
  → isolated network namespace / container
  → controlled DNS resolver and egress proxy
  → approved public HTTP/HTTPS destinations
```

The production implementation must provide:

- no route to the host network, RFC1918 networks, loopback, link-local, or carrier-grade NAT;
- explicit blocking of cloud metadata endpoints;
- no route to container control planes, databases, Redis, or internal services;
- DNS only through the controlled resolver;
- TCP egress only through the controlled proxy and only to approved destinations;
- equivalent IPv6 filtering, or IPv6 disabled;
- Chromium running as non-root with its sandbox enabled;
- no Docker socket or unnecessary host filesystem mounts.

The proxy must validate every resolution and redirect at connection time or bind connections to the
validated address. Application pre-resolution alone does not prevent DNS rebinding.
