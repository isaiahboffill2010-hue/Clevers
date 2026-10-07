# ADR 0001: Monorepo architecture

- Status: Accepted
- Date: 2026-10-06

## Decision

Use a pnpm and Turborepo TypeScript monorepo containing:

- a Next.js frontend in `apps/web`;
- a separately deployable Node.js browser service in `apps/browser-service`;
- a controlled fixture site in `apps/test-site`;
- a shared, narrowly scoped protocol package;
- a security package reserved for later policy helpers; and
- shared TypeScript configuration.

The browser service is deliberately not hosted inside Next.js. It will eventually own long-lived
browser processes and has different lifecycle, isolation, and scaling requirements.

## Consequences

Application boundaries remain deployable independently while protocol and tooling changes can be
made atomically. The monorepo does not imply that applications share runtime state.
