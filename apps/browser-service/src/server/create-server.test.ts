import type { SessionId } from "@remote-browser/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationResult, ProofResult, SessionSnapshot } from "../sessions/session-types.js";
import { type BrowserController, createServer } from "./create-server.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("browser service", () => {
  it("reports its health", async () => {
    const server = createServer();
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "browser-service" });
  });

  it("supports the bounded Phase 2 session API without accepting a URL", async () => {
    const sessionId = "test-session" as SessionId;
    const controller: BrowserController = {
      createSession: vi.fn(async (): Promise<SessionSnapshot> => ({ sessionId, state: "ready" })),
      getSession: vi.fn((): SessionSnapshot => ({ sessionId, state: "active" })),
      runProof: vi.fn(
        async (): Promise<ProofResult> => ({
          sessionId,
          state: "active",
          url: "http://127.0.0.1:3002/",
          title: "Remote Browser Test Site",
          screenshotCaptured: true,
          screenshotBytes: 100,
        }),
      ),
      navigate: vi.fn(
        async (): Promise<NavigationResult> => ({
          sessionId,
          state: "active",
          url: "https://example.com/",
          title: "Example Domain",
        }),
      ),
      destroySession: vi.fn(async () => true),
      shutdown: vi.fn(async () => undefined),
    };
    const server = createServer({ browserController: controller });
    servers.push(server);

    const createResponse = await server.inject({
      method: "POST",
      url: "/internal/browser-session",
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toEqual({ ok: true, sessionId, state: "ready" });

    const rejectedUrl = await server.inject({
      method: "POST",
      url: "/internal/browser-session",
      payload: { url: "https://example.com" },
    });
    expect(rejectedUrl.statusCode).toBe(400);

    const proofResponse = await server.inject({
      method: "POST",
      url: `/internal/browser-session/${sessionId}/run-proof`,
    });
    expect(proofResponse.statusCode).toBe(200);
    expect(proofResponse.json()).toMatchObject({ ok: true, screenshotCaptured: true });

    const statusResponse = await server.inject({
      method: "GET",
      url: `/internal/browser-session/${sessionId}`,
    });
    expect(statusResponse.json()).toEqual({ ok: true, sessionId, state: "active" });

    const deleteResponse = await server.inject({
      method: "DELETE",
      url: `/internal/browser-session/${sessionId}`,
    });
    expect(deleteResponse.json()).toEqual({ ok: true, sessionId, destroyed: true });
  });

  it("validates the navigation request shape", async () => {
    const sessionId = "test-session" as SessionId;
    const controller: BrowserController = {
      createSession: vi.fn(),
      getSession: vi.fn(),
      runProof: vi.fn(),
      navigate: vi.fn(
        async (): Promise<NavigationResult> => ({
          sessionId,
          state: "active",
          url: "https://example.com/",
          title: "Example Domain",
        }),
      ),
      destroySession: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const server = createServer({ browserController: controller });
    servers.push(server);

    const missing = await server.inject({
      method: "POST",
      url: `/internal/browser-session/${sessionId}/navigate`,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "NAVIGATION_INVALID_URL" });

    const success = await server.inject({
      method: "POST",
      url: `/internal/browser-session/${sessionId}/navigate`,
      payload: { url: "https://example.com" },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toMatchObject({ ok: true, status: "active" });
  });
});
