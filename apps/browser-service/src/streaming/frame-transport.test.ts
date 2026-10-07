import { describe, expect, it } from "vitest";
import { decodeFrame } from "./frame-protocol.js";
import { LatestFrameTransport } from "./frame-transport.js";

describe("LatestFrameTransport", () => {
  it("bounds its queue at one and replaces stale frames", async () => {
    const sent: Buffer[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const transport = new LatestFrameTransport(async (packet) => {
      sent.push(packet);
      calls += 1;
      if (calls === 1) await blocked;
    });
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      transport.enqueue({ sequence, width: 800, height: 600, jpeg: Buffer.from([sequence]) });
    }
    expect(transport.snapshot()).toMatchObject({
      framesReceived: 100,
      framesDropped: 98,
      queueDepth: 1,
    });
    release?.();
    await eventually(() => sent.length === 2);
    expect(decodeFrame(sent[0] as Buffer).sequence).toBe(1);
    expect(decodeFrame(sent[1] as Buffer).sequence).toBe(100);
    expect(transport.snapshot().queueDepth).toBe(0);
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}
