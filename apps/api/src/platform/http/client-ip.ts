/**
 * Client address for throttling. Forwarded headers are spoofable, so they are read only
 * when MASCLI_TRUST_PROXY=1; then the right-most X-Forwarded-For entry is the one the
 * trusted proxy appended for the connection it received.
 */
export const resolveClientIp = (input: {
  trustProxy: boolean;
  forwardedFor: string | undefined;
  socket: string | undefined;
}): string => {
  if (input.trustProxy && input.forwardedFor) {
    const hops = input.forwardedFor
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    const last = hops.at(-1);
    if (last) return last;
  }
  return input.socket || 'unknown';
};
