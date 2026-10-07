import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FRAME_HEADER_BYTES,
  mapContainedPoint,
  PROTOCOL_VERSION,
  type ProtocolVersion,
  type RequestId,
  type SessionId,
  STREAM_PROTOCOL_VERSION,
  type TabId,
} from "./index.js";

describe("protocol foundation", () => {
  it("exposes protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expectTypeOf(PROTOCOL_VERSION).toEqualTypeOf<ProtocolVersion>();
  });

  it("defines the Phase 4 stream and frame versions", () => {
    expect(STREAM_PROTOCOL_VERSION).toBe(1);
    expect(FRAME_HEADER_BYTES).toBe(20);
  });

  it("keeps identifiers nominally distinct", () => {
    expectTypeOf<SessionId>().not.toEqualTypeOf<TabId>();
    expectTypeOf<TabId>().not.toEqualTypeOf<RequestId>();
  });

  it("maps contain-fit coordinates and rejects letterboxing", () => {
    const container = { left: 10, top: 20, width: 1000, height: 1000 };
    expect(mapContainedPoint(510, 520, container, 1000, 500)).toEqual({ x: 500, y: 250 });
    expect(mapContainedPoint(510, 100, container, 1000, 500)).toBeUndefined();
    expect(mapContainedPoint(10, 270, container, 1000, 500)).toEqual({ x: 0, y: 0 });
  });
});
