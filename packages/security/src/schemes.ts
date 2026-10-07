export const ALLOWED_NAVIGATION_SCHEMES = new Set(["http:", "https:"]);

export function isAllowedNavigationScheme(protocol: string): boolean {
  return ALLOWED_NAVIGATION_SCHEMES.has(protocol.toLowerCase());
}
