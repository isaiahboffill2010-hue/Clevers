import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { classifyIpAddress } from "./ip-policy.js";
import { isAllowedNavigationScheme } from "./schemes.js";

export type NavigationErrorCode =
  | "NAVIGATION_INVALID_URL"
  | "NAVIGATION_SCHEME_BLOCKED"
  | "NAVIGATION_CREDENTIALS_BLOCKED"
  | "NAVIGATION_CONTENT_BLOCKED"
  | "NAVIGATION_PORT_NOT_ALLOWED"
  | "NAVIGATION_PRIVATE_ADDRESS"
  | "NAVIGATION_DNS_FAILED"
  | "NAVIGATION_REDIRECT_BLOCKED"
  | "NAVIGATION_FAILED";

export class NavigationPolicyError extends Error {
  readonly code: NavigationErrorCode;

  constructor(code: NavigationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NavigationPolicyError";
    this.code = code;
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveHostname = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface DevelopmentException {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
}

export interface NavigationPolicyOptions {
  blockedHosts?: readonly string[];
  developmentMode?: boolean;
  developmentExceptions?: readonly DevelopmentException[];
  resolveHostname?: ResolveHostname;
}

export interface ApprovedNavigation {
  url: string;
  origin: string;
  hostname: string;
}

export class NavigationPolicy {
  readonly #blockedHosts: ReadonlySet<string>;
  readonly #developmentMode: boolean;
  readonly #developmentExceptions: readonly DevelopmentException[];
  readonly #resolveHostname: ResolveHostname;

  constructor(options: NavigationPolicyOptions) {
    this.#blockedHosts = new Set((options.blockedHosts ?? []).map(normalizeHostname));
    this.#developmentMode = options.developmentMode ?? false;
    this.#developmentExceptions = (options.developmentExceptions ?? []).map((exception) => ({
      ...exception,
      hostname: normalizeHostname(exception.hostname),
    }));
    this.#resolveHostname = options.resolveHostname ?? resolveWithNode;
  }

  async validate(input: string, redirect = false): Promise<ApprovedNavigation> {
    return this.#validateNetworkDestination(input, redirect, false);
  }

  async validateNetworkRequest(
    input: string,
    redirect = false,
  ): Promise<ApprovedNavigation> {
    return this.#validateNetworkDestination(input, redirect, true);
  }

  async #validateNetworkDestination(
    input: string,
    redirect: boolean,
    allowWebSocket: boolean,
  ): Promise<ApprovedNavigation> {
    let url: URL;
    try {
      url = new URL(input);
    } catch (cause) {
      throw this.#error(
        "NAVIGATION_INVALID_URL",
        "The navigation URL is malformed",
        redirect,
        cause,
      );
    }

    if (
      !isAllowedNavigationScheme(url.protocol) &&
      !(allowWebSocket && (url.protocol === "ws:" || url.protocol === "wss:"))
    ) {
      throw this.#error(
        "NAVIGATION_SCHEME_BLOCKED",
        "The navigation scheme is not permitted",
        redirect,
      );
    }
    if (url.username || url.password) {
      throw this.#error(
        "NAVIGATION_CREDENTIALS_BLOCKED",
        "Credentials in navigation URLs are not permitted",
        redirect,
      );
    }

    const hostname = normalizeHostname(url.hostname);
    if (!hostname) {
      throw this.#error("NAVIGATION_INVALID_URL", "The navigation URL has no hostname", redirect);
    }
    if (isIP(hostname) !== 6) url.hostname = hostname;

    const port = effectivePort(url);
    const developmentException = this.#matchesDevelopmentException(url.protocol, hostname, port);
    if (!developmentException && matchesHostnameList(hostname, this.#blockedHosts)) {
      throw this.#error(
        "NAVIGATION_CONTENT_BLOCKED",
        "The destination is blocked by the content policy",
        redirect,
      );
    }
    const literalVersion = isIP(hostname);
    if (literalVersion > 0) {
      this.#assertAddressAllowed(hostname, developmentException, redirect);
    }
    if (literalVersion === 0 && !developmentException && isInternalHostname(hostname)) {
      throw this.#error(
        "NAVIGATION_PRIVATE_ADDRESS",
        "Internal hostnames are not permitted",
        redirect,
      );
    }
    if (!developmentException) {
      if (!isStandardPort(url.protocol, port)) {
        throw this.#error(
          "NAVIGATION_PORT_NOT_ALLOWED",
          "The destination port is not permitted",
          redirect,
        );
      }
    }

    if (literalVersion === 0) {
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await this.#resolveHostname(hostname);
      } catch (cause) {
        throw this.#error(
          "NAVIGATION_DNS_FAILED",
          "The destination hostname could not be resolved",
          redirect,
          cause,
        );
      }
      if (addresses.length === 0) {
        throw this.#error(
          "NAVIGATION_DNS_FAILED",
          "The destination hostname returned no addresses",
          redirect,
        );
      }
      for (const result of addresses) {
        this.#assertAddressAllowed(result.address, developmentException, redirect);
      }
    }

    return { url: url.toString(), origin: url.origin, hostname };
  }

  #matchesDevelopmentException(protocol: string, hostname: string, port: number): boolean {
    return (
      this.#developmentMode &&
      this.#developmentExceptions.some(
        (exception) =>
          exception.protocol === protocol &&
          exception.hostname === hostname &&
          exception.port === port,
      )
    );
  }

  #assertAddressAllowed(address: string, developmentException: boolean, redirect: boolean): void {
    const classification = classifyIpAddress(address);
    if (!classification) {
      throw this.#error(
        "NAVIGATION_DNS_FAILED",
        "The destination returned an invalid network address",
        redirect,
      );
    }
    if (!classification.isPublic && !developmentException) {
      throw this.#error(
        "NAVIGATION_PRIVATE_ADDRESS",
        "The destination resolves to a non-public address",
        redirect,
      );
    }
  }

  #error(
    code: NavigationErrorCode,
    message: string,
    redirect: boolean,
    cause?: unknown,
  ): NavigationPolicyError {
    return new NavigationPolicyError(redirect ? "NAVIGATION_REDIRECT_BLOCKED" : code, message, {
      cause,
    });
  }
}

function normalizeHostname(value: string): string {
  const lowercase = value.toLowerCase().replace(/\.+$/, "");
  return lowercase.startsWith("[") && lowercase.endsWith("]") ? lowercase.slice(1, -1) : lowercase;
}

function matchesHostnameList(hostname: string, blockedHosts: ReadonlySet<string>): boolean {
  for (const blockedHost of blockedHosts) {
    if (blockedHost && (hostname === blockedHost || hostname.endsWith(`.${blockedHost}`)))
      return true;
  }
  return false;
}

function isInternalHostname(hostname: string): boolean {
  if (!hostname.includes(".")) return true;
  return ["localhost", "local", "internal", "home", "lan"].some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function effectivePort(url: URL): number {
  if (url.port) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
}

function isStandardPort(protocol: string, port: number): boolean {
  return (
    ((protocol === "http:" || protocol === "ws:") && port === 80) ||
    ((protocol === "https:" || protocol === "wss:") && port === 443)
  );
}

async function resolveWithNode(hostname: string): Promise<readonly ResolvedAddress[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}
