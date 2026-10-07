import type { ClientStreamMessage, KeyMessage, PointerButton } from "@remote-browser/protocol";
import type { BrowserContext, CDPSession, Page } from "playwright";

type InputMessage = Extract<ClientStreamMessage, { type: `input.${string}` }>;

export interface InputMetrics {
  received: number;
  forwarded: number;
  coalesced: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
}

export class InputController {
  readonly #context: BrowserContext;
  readonly #page: Page;
  #cdp: CDPSession | undefined;
  #focused = false;
  #x = 0;
  #y = 0;
  readonly #pressedButtons = new Set<PointerButton>();
  readonly #pressedKeys = new Map<string, KeyMessage>();
  #pendingMove: Extract<InputMessage, { type: "input.pointerMove" }> | undefined;
  #drainingMove = false;
  #received = 0;
  #forwarded = 0;
  #coalesced = 0;
  readonly #latencies: number[] = [];

  constructor(context: BrowserContext, page: Page) {
    this.#context = context;
    this.#page = page;
  }

  async start(): Promise<void> {
    this.#cdp = await this.#context.newCDPSession(this.#page);
  }

  async dispatch(message: InputMessage): Promise<void> {
    this.#received += 1;
    if (message.type === "input.focus") {
      this.#focused = true;
      await this.#page.bringToFront();
      return;
    }
    if (message.type === "input.blur") {
      await this.releaseAll();
      this.#focused = false;
      return;
    }
    if (!this.#focused) return;
    if (message.type === "input.pointerMove") {
      if (this.#pendingMove) this.#coalesced += 1;
      this.#pendingMove = message;
      if (!this.#drainingMove) void this.#drainMoves();
      return;
    }
    const started = performance.now();
    await this.#dispatchImmediate(message);
    this.#recordLatency(performance.now() - started);
  }

  async releaseAll(): Promise<void> {
    const cdp = this.#cdp;
    if (!cdp) return;
    for (const button of this.#pressedButtons) {
      await cdp
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: this.#x,
          y: this.#y,
          button,
          clickCount: 1,
          buttons: 0,
        })
        .catch(() => undefined);
    }
    for (const message of this.#pressedKeys.values()) {
      await cdp
        .send("Input.dispatchKeyEvent", keyboardPayload("keyUp", message))
        .catch(() => undefined);
    }
    this.#pressedButtons.clear();
    this.#pressedKeys.clear();
    this.#pendingMove = undefined;
  }

  async stop(): Promise<void> {
    await this.releaseAll();
    const cdp = this.#cdp;
    this.#cdp = undefined;
    await cdp?.detach().catch(() => undefined);
  }

  metrics(): InputMetrics {
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
      received: this.#received,
      forwarded: this.#forwarded,
      coalesced: this.#coalesced,
      averageLatencyMs: sorted.length ? total / sorted.length : 0,
      p95LatencyMs: sorted.length
        ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0)
        : 0,
    };
  }

  async #dispatchImmediate(
    message: Exclude<InputMessage, { type: "input.pointerMove" | "input.focus" | "input.blur" }>,
  ): Promise<void> {
    const cdp = this.#requireCdp();
    switch (message.type) {
      case "input.pointerDown":
      case "input.pointerUp": {
        this.#x = message.x;
        this.#y = message.y;
        if (message.type === "input.pointerDown") this.#pressedButtons.add(message.button);
        else this.#pressedButtons.delete(message.button);
        await cdp.send("Input.dispatchMouseEvent", {
          type: message.type === "input.pointerDown" ? "mousePressed" : "mouseReleased",
          x: message.x,
          y: message.y,
          button: message.button,
          buttons: message.buttons,
          clickCount: message.clickCount,
          modifiers: message.modifiers,
        });
        break;
      }
      case "input.wheel":
        this.#x = message.x;
        this.#y = message.y;
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: message.x,
          y: message.y,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          modifiers: message.modifiers,
        });
        break;
      case "input.keyDown":
        this.#pressedKeys.set(message.code, message);
        await cdp.send("Input.dispatchKeyEvent", keyboardPayload("keyDown", message));
        break;
      case "input.keyUp":
        this.#pressedKeys.delete(message.code);
        await cdp.send("Input.dispatchKeyEvent", keyboardPayload("keyUp", message));
        break;
      case "input.insertText":
        await cdp.send("Input.insertText", { text: message.text });
        break;
    }
    this.#forwarded += 1;
  }

  async #drainMoves(): Promise<void> {
    this.#drainingMove = true;
    while (this.#pendingMove) {
      const message = this.#pendingMove;
      this.#pendingMove = undefined;
      const started = performance.now();
      this.#x = message.x;
      this.#y = message.y;
      await this.#requireCdp().send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: message.x,
        y: message.y,
        buttons: message.buttons,
        modifiers: message.modifiers,
      });
      this.#forwarded += 1;
      this.#recordLatency(performance.now() - started);
    }
    this.#drainingMove = false;
  }

  #recordLatency(value: number): void {
    this.#latencies.push(value);
    if (this.#latencies.length > 2_000) this.#latencies.shift();
  }

  #requireCdp(): CDPSession {
    if (!this.#cdp) throw new Error("Input controller is not attached");
    return this.#cdp;
  }
}

function keyboardPayload(type: "keyDown" | "keyUp", message: KeyMessage) {
  const virtualKeyCode =
    VIRTUAL_KEY_CODES[message.key] ??
    (message.key.length === 1 ? message.key.toUpperCase().charCodeAt(0) : 0);
  return {
    type,
    key: message.key,
    code: message.code,
    autoRepeat: message.repeat,
    location: message.location,
    modifiers: message.modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
}

const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};
