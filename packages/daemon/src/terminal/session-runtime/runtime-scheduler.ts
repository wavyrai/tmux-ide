/** Cancelable timer abstraction used by deterministic runtime qualification. */
export interface SessionRuntimeTimer {
  cancel(): void;
}

export interface SessionRuntimeScheduler {
  readonly nowMs: () => number;
  readonly createId: () => string;
  readonly microtask: (task: () => void) => void;
  readonly timer: (task: () => void, delayMs: number) => SessionRuntimeTimer;
}

export const SYSTEM_SESSION_RUNTIME_SCHEDULER: SessionRuntimeScheduler = Object.freeze({
  nowMs: () => performance.now(),
  createId: () => crypto.randomUUID(),
  microtask: (task: () => void) => queueMicrotask(task),
  timer: (task: () => void, delayMs: number) => {
    const handle = setTimeout(task, delayMs);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
});
