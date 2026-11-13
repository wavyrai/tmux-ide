/**
 * A roster answers "is this row current" with no while it re-reads the row's
 * session, and it re-reads whenever an agent appears or changes: the moment a
 * row gets clicked. This waits for that re-read to finish instead of taking
 * the no for an answer.
 */
export const ROSTER_SETTLE_MS = 3_000;

/**
 * Resolves true as soon as the target is current, false as soon as the roster
 * is not re-reading and the target still is not current, and whatever holds at
 * the bound or when `signal` aborts (aborted: false).
 */
export function waitForRosterTarget(options: {
  readonly isCurrent: () => boolean;
  readonly refreshing: () => boolean;
  /** Called on every roster publication; may deliver one synchronously. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly signal: AbortSignal;
  readonly boundMs?: number;
}): Promise<boolean> {
  if (options.signal.aborted) return Promise.resolve(false);
  if (options.isCurrent()) return Promise.resolve(true);
  if (!options.refreshing()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let stop: (() => void) | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      stop?.();
      resolve(value);
    };
    const abort = (): void => finish(false);
    const check = (): void => {
      if (settled) return;
      if (options.isCurrent()) finish(true);
      else if (!options.refreshing()) finish(false);
    };
    const timer = setTimeout(
      () => finish(options.isCurrent()),
      options.boundMs ?? ROSTER_SETTLE_MS,
    );
    (timer as { unref?: () => void }).unref?.();
    options.signal.addEventListener("abort", abort, { once: true });
    const unsubscribe = options.subscribe(check);
    if (settled) unsubscribe();
    else stop = unsubscribe;
  });
}
