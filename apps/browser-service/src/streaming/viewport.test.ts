import { describe, expect, it } from "vitest";
import { parseViewport } from "./viewport.js";

describe("viewport validation", () => {
  it("accepts the inclusive limits", () => {
    expect(parseViewport({ width: 320, height: 240 })).toEqual({ width: 320, height: 240 });
    expect(parseViewport({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
  });

  it.each([
    { width: 319, height: 240 },
    { width: 320, height: 239 },
    { width: 1921, height: 1080 },
    { width: 1280.5, height: 720 },
    { width: "1280", height: 720 },
  ])("rejects invalid dimensions %#", (value) => {
    expect(parseViewport(value)).toBeUndefined();
  });
});
