import { describe, expect, it } from "vitest";
import { classifyIpAddress } from "./ip-policy.js";

describe("classifyIpAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "carrier-grade-nat"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["192.0.2.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["240.0.0.1", "reserved"],
    ["93.184.216.34", "public"],
  ])("classifies IPv4 %s as %s", (address, category) => {
    expect(classifyIpAddress(address)).toMatchObject({ category, version: 4 });
  });

  it.each([
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "private"],
    ["fd12::1", "private"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["2606:2800:220:1:248:1893:25c8:1946", "public"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
  ])("classifies IPv6 %s as %s", (address, category) => {
    expect(classifyIpAddress(address)).toMatchObject({ category, version: 6 });
  });

  it("returns undefined for non-IP input", () => {
    expect(classifyIpAddress("example.com")).toBeUndefined();
  });
});
