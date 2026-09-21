/** Cancelable timer abstraction used by deterministic runtime qualification. */
export interface SessionRuntimeTimer {
  cancel(): void;
}

export interface SessionRuntimeScheduler {
  readonly nowMs: () => number;
  readonly createId: () => string;
  readonly microtask: (task: () => void) => void;
  readonly timer: (task: () => void, delayMs: number) => SessionRuntimeTimer;
  /** Cooperative I/O turn without imposing a timeout's minimum delay. */
  readonly yieldTask?: (task: () => void) => SessionRuntimeTimer;
}

export const SYSTEM_SESSION_RUNTIME_SCHEDULER: SessionRuntimeScheduler = Object.freeze({
  nowMs: () => performance.now(),
  createId: () => crypto.randomUUID(),
  microtask: (task: () => void) => queueMicrotask(task),
  yieldTask: (task: () => void) => {
    // Active work must progress even when sockets are quiet; an unreferenced
    // immediate may wait for an unrelated timer to wake the event loop.
    const handle = setImmediate(task);
    return { cancel: () => clearImmediate(handle) };
  },
  timer: (task: () => void, delayMs: number) => {
    const handle = setTimeout(task, delayMs);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
});
