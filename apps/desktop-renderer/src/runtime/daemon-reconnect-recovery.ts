/** Rediscover daemon authority only while a previously live workspace is stale. */
export function createDaemonReconnectRecovery(refresh: () => Promise<void>) {
  let lostGeneration: string | null = null;
  let liveGeneration: string | null = null;
  let attempt = 0;
  let epoch = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flight: Promise<void> | null = null;

  const stop = (): void => {
    epoch += 1;
    lostGeneration = null;
    liveGeneration = null;
    attempt = 0;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (): void => {
    if (disposed || lostGeneration === null || timer !== null || attempt >= 8) return;
    timer = setTimeout(
      () => {
        timer = null;
        if (flight !== null) return;
        const startedEpoch = epoch;
        attempt += 1;
        const operation = Promise.resolve()
          .then(refresh)
          .catch(() => undefined)
          .finally(() => {
            if (flight !== operation) return;
            flight = null;
            if (startedEpoch !== epoch && lostGeneration === null) return;
            schedule();
          });
        flight = operation;
      },
      Math.min(250 * 2 ** attempt, 2_000),
    );
  };
  return {
    observe(generation: string, phase: string): void {
      if (disposed) return;
      if (phase === "live") {
        stop();
        liveGeneration = generation;
        return;
      }
      if (liveGeneration !== null && generation !== liveGeneration) stop();
      if (phase === "stale" && liveGeneration === generation && lostGeneration === null) {
        lostGeneration = generation;
        schedule();
      }
    },
    stop,
    dispose(): void {
      disposed = true;
      stop();
    },
  };
}
