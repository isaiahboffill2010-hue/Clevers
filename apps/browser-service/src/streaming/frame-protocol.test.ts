import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame } from "./frame-protocol.js";

describe("binary frame protocol", () => {
  it("round-trips the fixed header and JPEG bytes", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const packet = encodeFrame({ sequence: 42, width: 1280, height: 720, format: "jpeg" }, jpeg);
    const decoded = decodeFrame(packet);
    expect(decoded).toMatchObject({ sequence: 42, width: 1280, height: 720, format: "jpeg" });
    expect(Buffer.from(decoded.jpeg)).toEqual(jpeg);
  });

  it("rejects malformed and mismatched headers", () => {
    expect(() => decodeFrame(Buffer.alloc(4))).toThrow("Invalid remote viewport frame header");
    const packet = encodeFrame(
      { sequence: 1, width: 800, height: 600, format: "jpeg" },
      Buffer.from([1]),
    );
    packet.writeUInt8(9, 4);
    expect(() => decodeFrame(packet)).toThrow("Frame protocol mismatch");
  });
});
