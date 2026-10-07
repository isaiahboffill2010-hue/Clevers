import type { SessionId } from "@remote-browser/protocol";

export const SESSION_STATES = [
  "created",
  "initializing",
  "ready",
  "navigating",
  "active",
  "closing",
  "closed",
  "crashed",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export interface SessionSnapshot {
  sessionId: SessionId;
  state: SessionState;
}

export interface ProofResult extends SessionSnapshot {
  url: string;
  title: string;
  screenshotCaptured: boolean;
  screenshotBytes: number;
}

export interface NavigationResult extends SessionSnapshot {
  url: string;
  title: string;
}

export interface ManagedSession {
  readonly id: SessionId;
  readonly state: SessionState;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  markCrashed(reason: string): Promise<void>;
  snapshot(): SessionSnapshot;
}
