import type { SessionState } from "./session-types.js";

const ALLOWED_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  created: ["initializing", "closing", "crashed"],
  initializing: ["ready", "closing", "crashed"],
  ready: ["navigating", "closing", "crashed"],
  navigating: ["active", "ready", "closing", "crashed"],
  active: ["navigating", "closing", "crashed"],
  closing: ["closed", "crashed"],
  closed: [],
  crashed: ["closing", "closed"],
};

export class InvalidSessionTransitionError extends Error {
  constructor(from: SessionState, to: SessionState) {
    super(`Invalid session state transition: ${from} -> ${to}`);
    this.name = "InvalidSessionTransitionError";
  }
}

export class SessionLifecycle {
  #state: SessionState = "created";

  get state(): SessionState {
    return this.#state;
  }

  transition(to: SessionState): void {
    if (!ALLOWED_TRANSITIONS[this.#state].includes(to)) {
      throw new InvalidSessionTransitionError(this.#state, to);
    }
    this.#state = to;
  }
}
