import { exponentialReconnectBackoff } from "./connection-supervisor.ts";

interface QueuedDial {
  key: string;
  start(): void;
}

/** Bounds actual handshakes, including cancelled adapters that have not settled. */
export function createFleetDialScheduler(limit = 4) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid dial limit");
  const queue: QueuedDial[] = [];
  let active = 0;
  const drain = () => {
    while (active < limit && queue.length) queue.shift()!.start();
  };
  return {
    snapshot: () => ({ active, queued: queue.length, limit }),
    prioritize(key: string) {
      const index = queue.findIndex((entry) => entry.key === key);
      if (index > 0) queue.unshift(queue.splice(index, 1)[0]!);
    },
    run<T>(
      key: string,
      signal: AbortSignal,
      connect: () => Promise<T>,
      disposeLate: (value: T) => void | Promise<void>,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let started = false;
        let settled = false;
        const abort = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (!started) {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
          }
          reject(new Error("Fleet connection cancelled"));
        };
        const entry: QueuedDial = {
          key,
          start() {
            started = true;
            active++;
            let work: Promise<T>;
            try {
              work = connect();
            } catch (error) {
              work = Promise.reject(error);
            }
            void work
              .then(
                async (value) => {
                  if (settled) {
                    await disposeLate(value);
                  } else {
                    settled = true;
                    resolve(value);
                  }
                },
                (error: unknown) => {
                  if (!settled) {
                    settled = true;
                    reject(error);
                  }
                },
              )
              .catch(() => {
                // Late cleanup cannot revive a cancelled request.
              })
              .finally(() => {
                signal.removeEventListener("abort", abort);
                active--;
                drain();
              });
          },
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else {
          queue.push(entry);
          drain();
        }
      });
    },
  };
}

export type FleetDialScheduler = ReturnType<typeof createFleetDialScheduler>;

/** Equal jitter prevents synchronized fleet retries without zero-delay retry storms. */
export function fleetReconnectBackoff(attempt: number, random = Math.random): number {
  const cap = exponentialReconnectBackoff(attempt);
  const sample = random();
  const bounded = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  return Math.floor(cap * (0.5 + bounded * 0.5));
}
