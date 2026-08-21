import type { SessionRuntimeAuthorityLease } from "@tmux-ide/contracts";

export interface TerminalInputAuthorityLane {
  readonly ownsInput: boolean;
  requestAuthority(authority: "input"): Promise<SessionRuntimeAuthorityLease | null>;
  noteActivity(activity: "input"): void;
}

interface QueuedInput {
  readonly isCurrent: () => boolean;
  readonly dispatch: () => void;
  readonly onRejected?: () => void;
}

interface LaneQueue {
  readonly inputs: QueuedInput[];
}

/** A paste/key-repeat burst is bounded without sacrificing input order. */
export const MAX_PENDING_AUTHORITY_INPUTS = 256;
const laneQueues = new WeakMap<object, LaneQueue>();

/** Preserve ordered input in the focus→authority receipt race. */
export function dispatchTerminalInputWithAuthority(options: {
  readonly lane: TerminalInputAuthorityLane;
  readonly isCurrent: () => boolean;
  readonly dispatch: () => void;
  readonly onRejected?: () => void;
}): "sent" | "queued" {
  if (options.lane.ownsInput) {
    options.lane.noteActivity("input");
    options.dispatch();
    return "sent";
  }

  const queued: QueuedInput = {
    isCurrent: options.isCurrent,
    dispatch: options.dispatch,
    onRejected: options.onRejected,
  };
  const existing = laneQueues.get(options.lane);
  if (existing) {
    if (existing.inputs.length >= MAX_PENDING_AUTHORITY_INPUTS) {
      if (options.isCurrent()) options.onRejected?.();
      return "queued";
    }
    existing.inputs.push(queued);
    return "queued";
  }

  const state: LaneQueue = { inputs: [queued] };
  laneQueues.set(options.lane, state);
  void options.lane
    .requestAuthority("input")
    .then((lease) => {
      if (laneQueues.get(options.lane) === state) laneQueues.delete(options.lane);
      if (!lease || !options.lane.ownsInput) {
        for (const input of state.inputs.splice(0)) {
          if (input.isCurrent()) input.onRejected?.();
        }
        return;
      }
      // Drain one stable snapshot. New input cannot interleave because promise
      // continuations run to completion; every dispatch retains call order.
      for (const input of state.inputs.splice(0)) {
        if (!input.isCurrent()) continue;
        options.lane.noteActivity("input");
        input.dispatch();
      }
    })
    .catch(() => {
      if (laneQueues.get(options.lane) === state) laneQueues.delete(options.lane);
      for (const input of state.inputs.splice(0)) {
        if (input.isCurrent()) input.onRejected?.();
      }
    });
  return "queued";
}
