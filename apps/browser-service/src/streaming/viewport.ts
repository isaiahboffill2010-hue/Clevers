import { VIEWPORT_LIMITS } from "../config.js";

export interface ViewportSize {
  width: number;
  height: number;
}

export function parseViewport(value: unknown): ViewportSize | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.width) || !Number.isInteger(candidate.height)) return undefined;
  const width = candidate.width as number;
  const height = candidate.height as number;
  if (
    width < VIEWPORT_LIMITS.minimum.width ||
    height < VIEWPORT_LIMITS.minimum.height ||
    width > VIEWPORT_LIMITS.maximum.width ||
    height > VIEWPORT_LIMITS.maximum.height
  ) {
    return undefined;
  }
  return { width, height };
}
