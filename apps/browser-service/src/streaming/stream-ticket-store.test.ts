import type { SessionId } from "@remote-browser/protocol";
import { describe, expect, it } from "vitest";
import { StreamTicketError, StreamTicketStore } from "./stream-ticket-store.js";

describe("StreamTicketStore", () => {
  it("issues a strong, session-bound, single-use ticket", () => {
    const store = new StreamTicketStore(30_000, () => 1_000);
    const sessionId = "session-a" as SessionId;
    const issued = store.issue(sessionId);
    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.consume(issued.ticket)).toBe(sessionId);
    expect(() => store.consume(issued.ticket)).toThrowError(StreamTicketError);
  });

  it("rejects expired and malformed tickets", () => {
    let now = 1_000;
    const store = new StreamTicketStore(50, () => now);
    const issued = store.issue("session-a" as SessionId);
    now = 1_051;
    expect(() => store.consume(issued.ticket)).toThrowError(
      expect.objectContaining({ reason: "expired" }),
    );
    expect(() => store.consume("not-a-ticket")).toThrowError(
      expect.objectContaining({ reason: "malformed" }),
    );
  });

  it("cannot substitute one session for another", () => {
    const store = new StreamTicketStore(30_000);
    const ticketA = store.issue("session-a" as SessionId);
    store.issue("session-b" as SessionId);
    expect(store.consume(ticketA.ticket)).toBe("session-a");
  });
});
