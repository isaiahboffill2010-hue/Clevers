import type { BrowserContext, CDPSession, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { InputController } from "./input-controller.js";

describe("InputController", () => {
  it("ignores keys until focused and releases held state on blur", async () => {
    const send = vi.fn(async () => undefined);
    const controller = createController(send);
    await controller.start();
    const key = {
      v: 1 as const,
      type: "input.keyDown" as const,
      key: "a",
      code: "KeyA",
      repeat: false,
      location: 0,
      modifiers: 0,
    };
    await controller.dispatch(key);
    expect(send).not.toHaveBeenCalled();
    await controller.dispatch({ v: 1, type: "input.focus" });
    await controller.dispatch(key);
    await controller.dispatch({
      v: 1,
      type: "input.pointerDown",
      x: 10,
      y: 20,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 8,
    });
    await controller.dispatch({ v: 1, type: "input.blur" });
    const calls = send.mock.calls as unknown as Array<[string, { type?: string }]>;
    expect(calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(true);
    expect(
      calls.filter(
        ([method, payload]) =>
          method === "Input.dispatchMouseEvent" && payload.type === "mouseReleased",
      ),
    ).toHaveLength(1);
  });

  it("coalesces pending pointer moves and records metrics", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let moves = 0;
    const send = vi.fn(async (_method: string, payload: { type?: string }) => {
      if (payload.type === "mouseMoved" && moves++ === 0) await blocked;
    });
    const controller = createController(send);
    await controller.start();
    await controller.dispatch({ v: 1, type: "input.focus" });
    for (let x = 0; x < 20; x += 1)
      await controller.dispatch({
        v: 1,
        type: "input.pointerMove",
        x,
        y: 5,
        buttons: 0,
        modifiers: 0,
      });
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.metrics().coalesced).toBeGreaterThan(0);
    expect(controller.metrics().forwarded).toBeLessThan(20);
  });
});

function createController(send: ReturnType<typeof vi.fn>) {
  const cdp = { send, detach: vi.fn(async () => undefined) } as unknown as CDPSession;
  const context = { newCDPSession: vi.fn(async () => cdp) } as unknown as BrowserContext;
  const page = { bringToFront: vi.fn(async () => undefined) } as unknown as Page;
  return new InputController(context, page);
}
