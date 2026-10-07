import type { SessionId } from "@remote-browser/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DuplicateSessionError,
  SessionLimitError,
  SessionNotFoundError,
  SessionRegistry,
} from "./session-registry.js";
import type { ManagedSession } from "./session-types.js";

function fakeSession(id: string): ManagedSession {
  return {
    id: id as SessionId,
    state: "ready",
    initialize: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    markCrashed: vi.fn(async () => undefined),
    snapshot: () => ({ sessionId: id as SessionId, state: "ready" }),
  };
}

describe("SessionRegistry", () => {
  it("adds, looks up, and destroys a session", async () => {
    const registry = new SessionRegistry();
    const session = fakeSession("session-a");
    registry.register(session);
    expect(registry.get("session-a")).toBe(session);
    expect(await registry.destroy("session-a")).toBe(true);
    expect(await registry.destroy("session-a")).toBe(false);
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it("rejects duplicate IDs", () => {
    const registry = new SessionRegistry();
    registry.register(fakeSession("duplicate"));
    expect(() => registry.register(fakeSession("duplicate"))).toThrow(DuplicateSessionError);
  });

  it("enforces the Phase 2 one-session limit", () => {
    const registry = new SessionRegistry();
    registry.register(fakeSession("first"));
    expect(() => registry.register(fakeSession("second"))).toThrow(SessionLimitError);
  });

  it("reports unknown sessions", () => {
    const registry = new SessionRegistry();
    expect(() => registry.get("missing")).toThrow(SessionNotFoundError);
  });
});
