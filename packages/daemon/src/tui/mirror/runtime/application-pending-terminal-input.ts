export interface PendingTerminalInputGeneration {
  readonly token: number;
  readonly sessionName: string;
}

export type PendingTerminalInputSettlement =
  | { readonly status: "ready"; readonly queued: number }
  | { readonly status: "unavailable"; readonly discarded: number }
  | { readonly status: "superseded"; readonly discarded: 0 };

export type PendingTerminalInputFlush =
  | { readonly status: "waiting"; readonly queued: number }
  | { readonly status: "flushed"; readonly delivered: number }
  | { readonly status: "superseded"; readonly discarded: number }
  | { readonly status: "idle" };

interface PendingInput {
  readonly deliver: () => void;
  readonly weight: number;
}

interface PendingGeneration {
  readonly identity: PendingTerminalInputGeneration;
  readonly inputs: PendingInput[];
  weight: number;
  generationKey: string | null;
  settled: boolean;
}

/**
 * Bounded first-input retention for a session generation that is still
 * connecting. Delivery is admitted only after the exact generation key and a
 * focused pane are both current; replacement opens fence the old queue.
 */
export function createApplicationPendingTerminalInputOwner(
  options: { readonly maximumInputs?: number; readonly maximumWeight?: number } = {},
) {
  const maximumInputs = options.maximumInputs ?? 64;
  const maximumWeight = options.maximumWeight ?? 1024 * 1024;
  let nextToken = 0;
  let pending: PendingGeneration | null = null;

  const discard = (): number => {
    const discarded = pending?.inputs.length ?? 0;
    pending = null;
    return discarded;
  };

  return {
    begin(sessionName: string): PendingTerminalInputGeneration {
      const identity = Object.freeze({ token: ++nextToken, sessionName });
      pending = { identity, inputs: [], weight: 0, generationKey: null, settled: false };
      return identity;
    },
    enqueue(deliver: () => void, weight = 1): "queued" | "overflow" | "unavailable" {
      if (!pending) return "unavailable";
      const boundedWeight = Number.isSafeInteger(weight) && weight > 0 ? weight : 1;
      if (pending.inputs.length >= maximumInputs || pending.weight + boundedWeight > maximumWeight)
        return "overflow";
      pending.inputs.push({ deliver, weight: boundedWeight });
      pending.weight += boundedWeight;
      return "queued";
    },
    settle(
      identity: PendingTerminalInputGeneration,
      result: { readonly opened: boolean; readonly generationKey: string | null },
    ): PendingTerminalInputSettlement {
      if (!pending || pending.identity.token !== identity.token)
        return { status: "superseded", discarded: 0 };
      if (!result.opened || result.generationKey === null) {
        return { status: "unavailable", discarded: discard() };
      }
      pending.settled = true;
      pending.generationKey = result.generationKey;
      return { status: "ready", queued: pending.inputs.length };
    },
    flush(current: {
      readonly sessionName: string | null;
      readonly generationKey: string | null;
      readonly focusedPane: string | null;
    }): PendingTerminalInputFlush {
      if (!pending) return { status: "idle" };
      if (!pending.settled || current.generationKey === null || current.focusedPane === null)
        return { status: "waiting", queued: pending.inputs.length };
      if (
        current.sessionName !== pending.identity.sessionName ||
        current.generationKey !== pending.generationKey
      )
        return { status: "superseded", discarded: discard() };
      const inputs = pending.inputs.slice();
      pending = null;
      for (const input of inputs) {
        try {
          input.deliver();
        } catch {
          // One malformed or retired input must not strand the remaining FIFO.
        }
      }
      return { status: "flushed", delivered: inputs.length };
    },
    snapshot(): Readonly<{
      sessionName: string | null;
      queued: number;
      settled: boolean;
    }> {
      return Object.freeze({
        sessionName: pending?.identity.sessionName ?? null,
        queued: pending?.inputs.length ?? 0,
        settled: pending?.settled ?? false,
      });
    },
    dispose(): void {
      nextToken += 1;
      discard();
    },
  };
}
