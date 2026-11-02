export type RetryDecision = { retry: true; nextAttemptAt: Date } | { retry: false };

/** `attemptsSoFar` counts attempts already made, including the one that just failed. */
export function decideRetry(
  attemptsSoFar: number,
  now: Date,
  { maxAttempts, baseDelayMs }: { maxAttempts: number; baseDelayMs: number },
): RetryDecision {
  if (attemptsSoFar >= maxAttempts) return { retry: false };
  const delayMs = baseDelayMs * 2 ** (attemptsSoFar - 1);
  return { retry: true, nextAttemptAt: new Date(now.getTime() + delayMs) };
}
