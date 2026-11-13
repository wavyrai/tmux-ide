export interface DaemonStopProgress {
  readonly started: boolean;
  readonly finished: boolean;
  readonly elapsedMs: number;
  /** The teardown stage in flight, or null when none is. */
  readonly stage: string | null;
  readonly stageMs: number;
  readonly completed: readonly { readonly stage: string; readonly ms: number }[];
  /** Steps inside the stage that have started and not settled, with their age. */
  readonly openSteps: readonly { readonly step: string; readonly ms: number }[];
  /** Steps settled so far; with `completed` it shows whether a slow stop still moves. */
  readonly stepsSettled: number;
}
/** Wraps one named step of a teardown; steps may run in parallel. */
export type TrackTeardownStep = <T>(step: string, work: () => T | Promise<T>) => Promise<T>;

/** Records which teardown stage a stop is in and how long each one took. */
export function createStopProgress(now: () => number = () => performance.now()): {
  begin(): void;
  run(stage: string, operation: () => void | Promise<void>): Promise<void>;
  track: TrackTeardownStep;
  finish(): DaemonStopProgress;
  snapshot(): DaemonStopProgress;
} {
  const open = new Map<symbol, { step: string; startedAt: number }>();
  let stepsSettled = 0;
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
      openSteps: [...open.values()].map((entry) => ({
        step: entry.step,
        ms: Math.round(at - entry.startedAt),
      })),
      stepsSettled,
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
    async track(step, work) {
      const key = Symbol(step);
      open.set(key, { step, startedAt: now() });
      try {
        return await work();
      } finally {
        open.delete(key);
        stepsSettled += 1;
      }
    },
    finish() {
      finishedAt ??= now();
      return snapshot();
    },
    snapshot,
  };
}
