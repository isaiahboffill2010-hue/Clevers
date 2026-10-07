# Threat model foundation

Phase 3 adds application-level URL, DNS, IP, hostname-content, and redirect policy. It does not claim that
network-layer SSRF or browser sandbox escape risks are solved.

## High-level threats

- Server-side request forgery and access to internal or metadata networks.
- Chromium sandbox escape from hostile remote content.
- Cross-session data leakage between users.
- Abusive CPU, memory, process, disk, and network consumption.
- Sensitive browser content, credentials, cookies, or tokens entering logs.
- Malicious uploads and downloads.

## Mandatory architecture rules

1. Chromium must run outside the Next.js process.
2. Browser workers must run in hardened containers before production use.
3. The Chromium sandbox must not be disabled in production.
4. Navigation permits public HTTP/S, denies configured adult hosts, and retains an exact development test-site exception.
5. Browser sessions are hostile, untrusted workloads.
6. Sensitive browsing content must not be logged.
7. Per-user isolation is a core requirement.

Application-level URL validation will not be treated as a sufficient SSRF defense.

## Phase 3 controls

- Only HTTP and HTTPS top-level URLs are accepted.
- URL credentials and non-standard public ports are rejected.
- Configured adult hosts and their subdomains are rejected before DNS resolution.
- Internal hostname forms such as single-label names, `.localhost`, `.local`, `.internal`, `.home`,
  and `.lan` are rejected.
- Every DNS answer must classify as public unless the exact development exception applies.
- IPv4, IPv6, and IPv4-mapped local/private/special addresses are rejected.
- Document responses are paused before redirect following and their relative or absolute `Location`
  target is validated before Chromium continues.
- Browser-context routing revalidates requests as defense in depth.
- Public `ws:` and `wss:` page-created connections use the same hostname, DNS, IP, port, and content
  checks; user-entered WebSocket URLs remain invalid top-level navigation.
- Service workers are disabled because Playwright routing cannot reliably observe requests they
  intercept. This prevents a service worker from bypassing application-level destination checks.

## Residual risk

Preflight DNS lookup and Playwright routing do not bind Chromium's eventual socket to the validated
address. DNS rebinding, browser-originated traffic outside observable routes, browser compromise,
and policy bypass bugs remain reasons to require a separate network namespace and controlled egress
proxy in production.

Hostname blocking is not full content classification. It cannot reliably classify pages on mixed
platforms, paths, search results, newly registered domains, or content reached after a site changes
behavior. Production needs a maintained category source or enforcing egress/DNS proxy; the URL,
DNS, IP, and redirect checks remain mandatory even with that service.

## Phase 4 controls

- A random 256-bit, short-lived, single-use ticket authorizes exactly one session.
- Only a SHA-256 ticket digest is retained server-side; tickets are absent from URLs and logs.
- Versioned control messages are shape checked and capped at 4096 bytes.
- Navigation, arbitrary commands, and mouse/keyboard/wheel input are rejected.
- Each session allows only one viewer and retains at most one pending frame.

Development CORS origins and unencrypted `ws:` are not production authentication. Production still
requires TLS, user authentication, origin enforcement, resource quotas, and isolated workers.

## Phase 5 controls

- Input is accepted only after ticket authentication and is bound to that connection's session.
- Strict message shapes reject client session IDs, URLs, invalid buttons, and extra properties.
- Coordinates are finite and must lie inside the current Chromium viewport.
- Per-connection input rate limiting and two-stage pointer-move coalescing bound work.
- Blur and disconnect release held remote buttons and keys.
- Input cannot bypass the Phase 3 navigation API or its URL, DNS, IP, and redirect policy.
