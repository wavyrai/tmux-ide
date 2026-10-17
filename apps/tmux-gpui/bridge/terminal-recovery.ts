/** One bounded recovery lifetime. Navigation invalidates both timers and awaits. */
export function createTerminalRecovery(options: {
  attempt(current: () => boolean): Promise<boolean>;
  exhausted(): void;
  delayMs?: number;
  limit?: number;
}) {
  let epoch = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    epoch++;
    running = false;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    cancel,
    start() {
      if (running) return;
      running = true;
      const token = ++epoch;
      let attempts = 0;
      const current = () => running && epoch === token;
      const step = async () => {
        if (!current()) return;
        let restored = false;
        try {
          restored = await options.attempt(current);
        } catch {
          // The caller preserves fixed diagnostics; no private transport errors.
        }
        if (!current()) return;
        if (restored) {
          running = false;
          return;
        }
        if (++attempts >= (options.limit ?? 30)) {
          running = false;
          options.exhausted();
          return;
        }
        timer = setTimeout(() => void step(), options.delayMs ?? 1000);
      };
      timer = setTimeout(() => void step(), options.delayMs ?? 1000);
    },
  };
}
