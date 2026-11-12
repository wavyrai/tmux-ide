export interface DaemonStopProgress {
  readonly started: boolean;
  readonly finished: boolean;
  readonly elapsedMs: number;
  /** The teardown stage in flight, or null when none is. */
  readonly stage: string | null;
  readonly stageMs: number;
  readonly completed: readonly { readonly stage: string; readonly ms: number }[];
}

/** Records which teardown stage a stop is in and how long each one took. */
export function createStopProgress(now: () => number = () => performance.now()): {
  begin(): void;
  run(stage: string, operation: () => void | Promise<void>): Promise<void>;
  finish(): DaemonStopProgress;
  snapshot(): DaemonStopProgress;
} {
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let stage: string | null = null;
  let stageStartedAt = 0;
  const completed: { stage: string; ms: number }[] = [];
  const snapshot = (): DaemonStopProgress => {
    const at = finishedAt ?? now();
    return {
      started: startedAt !== null,
      finished: finishedAt !== null,
      elapsedMs: startedAt === null ? 0 : Math.round(at - startedAt),
      stage,
      stageMs: stage === null ? 0 : Math.round(at - stageStartedAt),
      completed: completed.map((entry) => ({ ...entry })),
    };
  };
  return {
    begin() {
      startedAt ??= now();
    },
    async run(name, operation) {
      stage = name;
      stageStartedAt = now();
      try {
        await operation();
      } finally {
        completed.push({ stage: name, ms: Math.round(now() - stageStartedAt) });
        stage = null;
      }
    },
    finish() {
      finishedAt ??= now();
      return snapshot();
    },
    snapshot,
  };
}
