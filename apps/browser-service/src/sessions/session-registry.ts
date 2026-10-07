import { randomUUID } from "node:crypto";
import type { SessionId } from "@remote-browser/protocol";
import { MAX_ACTIVE_SESSIONS } from "../config.js";
import type { ManagedSession } from "./session-types.js";

export class SessionLimitError extends Error {
  constructor() {
    super(`Phase 2 permits at most ${MAX_ACTIVE_SESSIONS} active browser session`);
    this.name = "SessionLimitError";
  }
}

export class DuplicateSessionError extends Error {
  constructor(id: SessionId) {
    super(`Browser session already exists: ${id}`);
    this.name = "DuplicateSessionError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Browser session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionRegistry {
  readonly #sessions = new Map<SessionId, ManagedSession>();
  #acceptingSessions = true;

  get size(): number {
    return this.#sessions.size;
  }

  createId(): SessionId {
    return randomUUID() as SessionId;
  }

  register(session: ManagedSession): void {
    if (!this.#acceptingSessions) throw new Error("Browser service is shutting down");
    if (this.#sessions.has(session.id)) throw new DuplicateSessionError(session.id);
    if (this.#sessions.size >= MAX_ACTIVE_SESSIONS) throw new SessionLimitError();
    this.#sessions.set(session.id, session);
  }

  get(id: string): ManagedSession {
    const session = this.#sessions.get(id as SessionId);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  }

  remove(id: SessionId): void {
    this.#sessions.delete(id);
  }

  async destroy(id: string): Promise<boolean> {
    const session = this.#sessions.get(id as SessionId);
    if (!session) return false;
    try {
      await session.destroy();
    } finally {
      this.remove(session.id);
    }
    return true;
  }

  async destroyAll(): Promise<void> {
    this.#acceptingSessions = false;
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(sessions.map((session) => session.destroy()));
    this.#sessions.clear();
  }

  async handleBrowserDisconnected(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(
      sessions.map((session) => session.markCrashed("browser disconnected")),
    );
    this.#sessions.clear();
  }
}
