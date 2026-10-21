/** Single-producer admission: at most eight sends, and one waiting admission/barrier. */
export function createInputPipeline(onFailure: (error: unknown) => void) {
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  let retired = false;
  let waiting = false;
  let wake: (() => void) | undefined;
  const check = () => {
    if (retired) throw failure ?? new Error("Input pipeline retired");
  };
  const retire = (error: unknown = new Error("Input pipeline retired")) => {
    if (retired) return;
    retired = true;
    failure = error;
    wake?.();
  };
  const waitUntil = async (limit: number) => {
    check();
    if (waiting) throw new Error("Concurrent input admission");
    waiting = true;
    try {
      while (pending.size >= limit) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        check();
      }
    } finally {
      waiting = false;
    }
  };
  return {
    retire,
    async submit(send: () => Promise<void>) {
      check();
      if (pending.size >= 8) await waitUntil(8);
      // Retirement may occur between the capacity wake and this continuation.
      check();
      let operation: Promise<void>;
      try {
        operation = send();
      } catch (error) {
        retire(error);
        onFailure(error);
        throw error;
      }
      const tracked = operation
        .then(
          () => {},
          (error: unknown) => {
            if (retired) return;
            retire(error);
            onFailure(error);
          },
        )
        .finally(() => {
          pending.delete(tracked);
          wake?.();
        });
      pending.add(tracked);
    },
    async barrier() {
      await waitUntil(1);
      check();
    },
  };
}
