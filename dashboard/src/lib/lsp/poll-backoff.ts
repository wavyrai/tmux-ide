/**
 * Pure helper for the diagnostics poll's error-backoff schedule.
 *
 * Extracted so the math is testable without standing up Monaco. The
 * intent: after `n` consecutive errors, the next poll fires at
 *   min(maxMs, intervalMs * factor^(n-1))
 * — i.e. 5s → 10s → 20s → 40s → 60s cap with the production defaults.
 * `n=0` always returns the base `intervalMs` (no backoff).
 */

export interface PollBackoffConfig {
  /** Base cadence when there are zero consecutive errors. */
  intervalMs: number;
  /** Cap so a long-stale daemon doesn't push delays into minutes+. */
  maxMs: number;
  /** Multiplicative factor between successive failed polls. */
  factor: number;
}

export function computePollBackoffDelay(
  consecutiveErrors: number,
  config: PollBackoffConfig,
): number {
  if (consecutiveErrors <= 0) return config.intervalMs;
  const raw = config.intervalMs * Math.pow(config.factor, consecutiveErrors - 1);
  if (!Number.isFinite(raw) || raw > config.maxMs) return config.maxMs;
  return raw;
}
