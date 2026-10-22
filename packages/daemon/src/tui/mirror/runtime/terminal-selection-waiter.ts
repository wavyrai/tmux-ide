/** One bounded selection observation; never submits or repeats a mutation. */
export function createTerminalSelectionWaiter() {
  let pending: {
    check: () => boolean | "pending";
    finish: (selected: boolean) => void;
  } | null = null;
  const cancel = () => pending?.finish(false);
  const reconcile = () => {
    const waiting = pending;
    if (!waiting) return;
    const result = waiting.check();
    if (result !== "pending") waiting.finish(result);
  };
  return {
    cancel,
    reconcile,
    wait(check: () => boolean | "pending"): Promise<boolean> {
      cancel();
      return new Promise((resolve) => {
        const timer = setTimeout(() => waiting.finish(false), 5000);
        timer.unref?.();
        const waiting = {
          check,
          finish(selected: boolean) {
            if (pending !== waiting) return;
            pending = null;
            clearTimeout(timer);
            resolve(selected);
          },
        };
        pending = waiting;
        reconcile();
      });
    },
  };
}
