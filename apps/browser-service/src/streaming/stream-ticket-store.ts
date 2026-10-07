import { createHash, randomBytes } from "node:crypto";
import type { SessionId } from "@remote-browser/protocol";

export type TicketFailure = "malformed" | "expired" | "reused";

export class StreamTicketError extends Error {
  constructor(readonly reason: TicketFailure) {
    super(`Stream ticket is ${reason}`);
    this.name = "StreamTicketError";
  }
}

interface TicketRecord {
  sessionId: SessionId;
  expiresAt: number;
  consumed: boolean;
}

export class StreamTicketStore {
  readonly #tickets = new Map<string, TicketRecord>();

  constructor(
    readonly ttlMs: number,
    readonly now: () => number = Date.now,
  ) {}

  issue(sessionId: SessionId): { ticket: string; expiresAt: string } {
    this.#prune();
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.#tickets.set(hash(ticket), { sessionId, expiresAt, consumed: false });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(ticket: string): SessionId {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new StreamTicketError("malformed");
    const record = this.#tickets.get(hash(ticket));
    if (!record) throw new StreamTicketError("malformed");
    if (record.consumed) throw new StreamTicketError("reused");
    record.consumed = true;
    if (record.expiresAt <= this.now()) throw new StreamTicketError("expired");
    return record.sessionId;
  }

  #prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, record] of this.#tickets) {
      if (record.expiresAt < cutoff) this.#tickets.delete(key);
    }
  }
}

function hash(ticket: string): string {
  return createHash("sha256").update(ticket).digest("base64url");
}
