/** Failed-login limits within a sliding window (ADR 0004, OWASP Authentication Cheat Sheet). */
export const THROTTLE = { maxPerUser: 5, maxPerIp: 20, windowSeconds: 900 } as const;

export type ThrottleDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export const userSubject = (username: string) => `user:${username}`;
export const ipSubject = (ip: string) => `ip:${ip}`;

export const throttleDecision = (failures: {
  userFailures: number;
  ipFailures: number;
}): ThrottleDecision =>
  failures.userFailures >= THROTTLE.maxPerUser || failures.ipFailures >= THROTTLE.maxPerIp
    ? { allowed: false, retryAfterSeconds: THROTTLE.windowSeconds }
    : { allowed: true };
