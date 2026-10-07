import { NavigationPolicy, type NavigationPolicyOptions } from "@remote-browser/security";
import {
  BROWSER_TEST_TARGET_URL,
  ENABLE_LOCAL_TEST_TARGET,
  NAVIGATION_BLOCKED_HOSTS,
} from "../config.js";

export function createNavigationPolicy(
  controlledTarget = BROWSER_TEST_TARGET_URL,
  overrides: Partial<NavigationPolicyOptions> = {},
): NavigationPolicy {
  const developmentExceptions = controlledTargetException(controlledTarget);
  return new NavigationPolicy({
    blockedHosts: NAVIGATION_BLOCKED_HOSTS,
    developmentMode: ENABLE_LOCAL_TEST_TARGET,
    developmentExceptions,
    ...overrides,
  });
}

function controlledTargetException(
  target: string,
): NavigationPolicyOptions["developmentExceptions"] {
  if (!ENABLE_LOCAL_TEST_TARGET) return [];
  const url = new URL(target);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return [];
  return [{ protocol: "http:", hostname: "127.0.0.1", port: Number.parseInt(url.port, 10) }];
}
