import { describe, expect, it } from "vitest";
import { InvalidSessionTransitionError, SessionLifecycle } from "./session-lifecycle.js";

describe("SessionLifecycle", () => {
  it("allows the normal proof lifecycle", () => {
    const lifecycle = new SessionLifecycle();
    for (const state of [
      "initializing",
      "ready",
      "navigating",
      "active",
      "closing",
      "closed",
    ] as const) {
      lifecycle.transition(state);
    }
    expect(lifecycle.state).toBe("closed");
  });

  it("rejects invalid transitions", () => {
    const lifecycle = new SessionLifecycle();
    expect(() => lifecycle.transition("active")).toThrow(InvalidSessionTransitionError);
  });

  it("allows a crashed session to be cleaned up", () => {
    const lifecycle = new SessionLifecycle();
    lifecycle.transition("crashed");
    lifecycle.transition("closing");
    lifecycle.transition("closed");
    expect(lifecycle.state).toBe("closed");
  });
});
