export * from "./ip-policy.js";
export * from "./navigation-policy.js";
export * from "./schemes.js";

/** Application policy is active, but network-level enforcement remains required. */
export const SECURITY_POLICY_STATUS = "application-policy-only" as const;

export type SecurityPolicyStatus = typeof SECURITY_POLICY_STATUS;
