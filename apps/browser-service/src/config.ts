export const BROWSER_TEST_TARGET_URL =
  process.env.BROWSER_TEST_TARGET_URL ?? "http://127.0.0.1:3002";

export const BROWSER_VIEWPORT = { width: 1280, height: 720 } as const;
export const SESSION_INITIALIZATION_TIMEOUT_MS = 10_000;
export const NAVIGATION_TIMEOUT_MS = 15_000;
export const SHUTDOWN_TIMEOUT_MS = 15_000;
export const MAX_ACTIVE_SESSIONS = 1;
export const STREAM_TICKET_TTL_MS = 30_000;
export const STREAM_AUTH_TIMEOUT_MS = 5_000;
export const STREAM_HEARTBEAT_INTERVAL_MS = 30_000;
export const STREAM_MAX_CONTROL_BYTES = 4_096;
export const SCREENCAST_CONFIG = {
  format: "jpeg" as const,
  quality: 70,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1,
};
export const VIEWPORT_LIMITS = {
  minimum: { width: 320, height: 240 },
  maximum: { width: 1920, height: 1080 },
};
export const NAVIGATION_BLOCKED_HOSTS = (
  process.env.NAVIGATION_BLOCKED_HOSTS ??
  "adult.example,pornhub.com,xvideos.com,xnxx.com,redtube.com,youporn.com"
)
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
export const ENABLE_LOCAL_TEST_TARGET =
  process.env.ENABLE_LOCAL_TEST_TARGET === "true" || process.env.NODE_ENV !== "production";
export const ENABLE_NAVIGATION_DIAGNOSTICS =
  process.env.NODE_ENV !== "production" && process.env.NAVIGATION_DIAGNOSTICS === "true";
export const WEB_ALLOWED_ORIGINS = (
  process.env.BROWSER_SERVICE_ALLOWED_ORIGINS ?? "http://127.0.0.1:3000,http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
export const REQUIRE_WEB_ORIGIN = process.env.NODE_ENV === "production";

export const EXPECTED_TEST_SITE_TITLE = "Remote Browser Test Site";
export const EXPECTED_TEST_SITE_TEXT = "Phase 1 test fixture is running.";
