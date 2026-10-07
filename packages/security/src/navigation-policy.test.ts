import { describe, expect, it } from "vitest";
import {
  NavigationPolicy,
  NavigationPolicyError,
  type ResolveHostname,
} from "./navigation-policy.js";

const publicResolver: ResolveHostname = async () => [
  { address: "93.184.216.34", family: 4 as const },
];

function policy(resolveHostname: ResolveHostname = publicResolver): NavigationPolicy {
  return new NavigationPolicy({
    blockedHosts: ["adult.example"],
    developmentMode: true,
    developmentExceptions: [{ protocol: "http:", hostname: "127.0.0.1", port: 3212 }],
    resolveHostname,
  });
}

async function expectCode(input: string, code: string): Promise<void> {
  await expect(policy().validate(input)).rejects.toMatchObject({ code });
}

describe("NavigationPolicy URL and host validation", () => {
  it.each(["http://example.com", "https://example.com/path", "HTTPS://EXAMPLE.COM/"])(
    "allows and normalizes %s",
    async (input) => {
      const result = await policy().validate(input);
      expect(result.hostname).toBe("example.com");
      expect(result.url).toMatch(/^https?:\/\/example\.com/);
    },
  );

  it("normalizes a Unicode hostname to punycode", async () => {
    const result = await policy().validate("https://bücher.example/");
    expect(result.hostname).toBe("xn--bcher-kva.example");
  });

  it("allows public hosts by default and normalizes trailing dots", async () => {
    expect((await policy().validate("https://example.com./")).hostname).toBe("example.com");
    await expect(policy().validate("https://example.com.attacker.test/")).resolves.toMatchObject({
      hostname: "example.com.attacker.test",
    });
  });

  it("blocks configured adult hosts and their subdomains without overmatching", async () => {
    await expectCode("https://adult.example/", "NAVIGATION_CONTENT_BLOCKED");
    await expectCode("https://media.adult.example./", "NAVIGATION_CONTENT_BLOCKED");
    await expect(policy().validate("https://adult.example.safe.test/")).resolves.toBeDefined();
  });

  it("rejects malformed and credential-bearing URLs", async () => {
    await expectCode("not a URL", "NAVIGATION_INVALID_URL");
    await expectCode("https://user:secret@example.com/", "NAVIGATION_CREDENTIALS_BLOCKED");
  });

  it("rejects unusual public ports", async () => {
    await expectCode("https://example.com:444/", "NAVIGATION_PORT_NOT_ALLOWED");
  });

  it("handles percent encoding without confusing the host boundary", async () => {
    const result = await policy().validate("https://example.com/a%2Fb?q=x%20y#fragment");
    expect(result.hostname).toBe("example.com");
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/file",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "blob:https://example.com/id",
    "about:blank",
    "chrome://settings",
    "chrome-extension://id/page.html",
    "devtools://devtools/bundled/",
    "filesystem:https://example.com/temporary/file",
    "view-source:https://example.com/",
    "ws://example.com/socket",
    "wss://example.com/socket",
    "custom://example.com/",
  ])("rejects blocked scheme: %s", async (input) => {
    await expectCode(input, "NAVIGATION_SCHEME_BLOCKED");
  });

  it("allows only the exact development exception", async () => {
    await expect(policy().validate("http://127.0.0.1:3212/phase3/approved")).resolves.toMatchObject(
      {
        hostname: "127.0.0.1",
      },
    );
    await expectCode("http://127.0.0.1/", "NAVIGATION_PRIVATE_ADDRESS");
    await expectCode("http://127.0.0.1:3213/", "NAVIGATION_PRIVATE_ADDRESS");
    await expectCode("http://localhost:3212/", "NAVIGATION_PRIVATE_ADDRESS");
  });

  it.each([
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://2130706433/",
  ])("rejects private target %s", async (input) => {
    await expectCode(input, "NAVIGATION_PRIVATE_ADDRESS");
  });
});

describe("NavigationPolicy DNS validation", () => {
  it("accepts only-all-public DNS results", async () => {
    await expect(policy().validate("https://example.com")).resolves.toBeDefined();
  });

  it("rejects a private DNS result", async () => {
    const resolver: ResolveHostname = async () => [{ address: "10.0.0.8", family: 4 }];
    await expect(policy(resolver).validate("https://example.com")).rejects.toMatchObject({
      code: "NAVIGATION_PRIVATE_ADDRESS",
    });
  });

  it("rejects mixed public and private DNS results", async () => {
    const resolver: ResolveHostname = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ];
    await expect(policy(resolver).validate("https://example.com")).rejects.toMatchObject({
      code: "NAVIGATION_PRIVATE_ADDRESS",
    });
  });

  it("maps resolution failure to a controlled error", async () => {
    const resolver: ResolveHostname = async () => {
      throw new Error("resolver detail must not reach the client");
    };
    await expect(policy(resolver).validate("https://example.com")).rejects.toMatchObject({
      code: "NAVIGATION_DNS_FAILED",
    });
  });

  it("maps redirect policy failures to the redirect error code", async () => {
    const error = await policy()
      .validate("https://adult.example/", true)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NavigationPolicyError);
    expect(error).toMatchObject({ code: "NAVIGATION_REDIRECT_BLOCKED" });
  });
});

describe("NavigationPolicy network-resource validation", () => {
  it.each(["ws://example.com/socket", "wss://example.com/socket"])(
    "allows public WebSocket destination %s",
    async (input) => {
      await expect(policy().validateNetworkRequest(input)).resolves.toBeDefined();
    },
  );

  it("keeps WebSocket schemes blocked for user navigation", async () => {
    await expectCode("wss://example.com/socket", "NAVIGATION_SCHEME_BLOCKED");
  });

  it.each(["ws://127.0.0.1/socket", "wss://metadata.internal/socket"])(
    "blocks unsafe WebSocket destination %s",
    async (input) => {
      await expect(policy().validateNetworkRequest(input)).rejects.toMatchObject({
        code: "NAVIGATION_PRIVATE_ADDRESS",
      });
    },
  );

  it("applies the content policy to WebSockets", async () => {
    await expect(
      policy().validateNetworkRequest("wss://adult.example/socket"),
    ).rejects.toMatchObject({ code: "NAVIGATION_CONTENT_BLOCKED" });
  });
});
