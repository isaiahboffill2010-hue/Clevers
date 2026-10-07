import { describe, expect, it } from "vitest";
import { SECURITY_POLICY_STATUS } from "./index.js";

describe("security package foundation", () => {
  it("makes the application-only policy status explicit", () => {
    expect(SECURITY_POLICY_STATUS).toBe("application-policy-only");
  });
});
