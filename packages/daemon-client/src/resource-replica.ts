/**
 * Host-neutral resource replica state machine shared by DOM and OpenTUI clients.
 *
 * Transports only translate their wire frames into these inputs. The reducer
 * owns daemon-generation retirement, event-gap detection and snapshot refresh
 * policy; it deliberately knows nothing about WebSockets, Solid or OpenTUI.
 */

export type ResourceReplicaPhase = "cold" | "syncing" | "live" | "stale" | "stopped";

export interface ResourceReplicaState<Value> {
  readonly phase: ResourceReplicaPhase;
  readonly daemonInstanceId: string | null;
  /** Last contiguous event sequence incorporated into this replica. */
  readonly sequence: number | null;
  /** Authoritative resource revision represented by `value`. */
  readonly revision: number | null;
  /** Last good value is intentionally retained while syncing or stale. */
  readonly value: Value | null;
  readonly reason:
    | "initial"
    | "generation-changed"
    | "event-gap"
    | "changed"
    | "disconnected"
    | null;
}

export type ResourceReplicaInput<Value> =
  | { readonly type: "connected"; readonly daemonInstanceId: string }
  | {
      readonly type: "snapshot";
      readonly daemonInstanceId: string;
      readonly sequence: number;
      readonly revision: number;
      readonly value: Value;
    }
  | {
      readonly type: "changed";
      readonly daemonInstanceId: string;
      readonly sequence: number;
      readonly revision: number;
      readonly causeOperationId?: string;
    }
  | {
      readonly type: "gap";
      readonly daemonInstanceId: string;
      readonly sequence: number;
    }
  | { readonly type: "disconnected" }
  | { readonly type: "stopped" };

export type ResourceReplicaEffect =
  | { readonly type: "request-snapshot"; readonly daemonInstanceId: string }
  | {
      readonly type: "refresh-resource";
      readonly daemonInstanceId: string;
      readonly minimumRevision: number;
    }
  | { readonly type: "retire-generation"; readonly daemonInstanceId: string };

export interface ResourceReplicaTransition<Value> {
  readonly state: ResourceReplicaState<Value>;
  readonly effects: readonly ResourceReplicaEffect[];
}

export function initialResourceReplica<Value>(): ResourceReplicaState<Value> {
  return {
    phase: "cold",
    daemonInstanceId: null,
    sequence: null,
    revision: null,
    value: null,
    reason: "initial",
  };
}

function validCounter(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function validIdentity(value: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new TypeError("daemonInstanceId must be a non-empty identity without NUL bytes.");
  }
}

function beginGeneration<Value>(
  previous: ResourceReplicaState<Value>,
  daemonInstanceId: string,
): ResourceReplicaTransition<Value> {
  const effects: ResourceReplicaEffect[] = [];
  if (previous.daemonInstanceId && previous.daemonInstanceId !== daemonInstanceId) {
    effects.push({ type: "retire-generation", daemonInstanceId: previous.daemonInstanceId });
  }
  effects.push({ type: "request-snapshot", daemonInstanceId });
  return {
    state: {
      phase: "syncing",
      daemonInstanceId,
      sequence: null,
      revision: null,
      value: previous.value,
      reason: previous.daemonInstanceId ? "generation-changed" : "initial",
    },
    effects,
  };
}

/**
 * Advance one resource replica. Every returned effect is idempotent: hosts may
 * collapse duplicate snapshot/refresh requests while one is already in flight.
 */
export function advanceResourceReplica<Value>(
  previous: ResourceReplicaState<Value>,
  input: ResourceReplicaInput<Value>,
): ResourceReplicaTransition<Value> {
  if (input.type === "disconnected") {
    if (previous.phase === "stopped") return { state: previous, effects: [] };
    return {
      state: { ...previous, phase: "stale", reason: "disconnected" },
      effects: [],
    };
  }
  if (input.type === "stopped") {
    const effects: ResourceReplicaEffect[] = previous.daemonInstanceId
      ? [{ type: "retire-generation", daemonInstanceId: previous.daemonInstanceId }]
      : [];
    return {
      state: { ...previous, phase: "stopped", reason: null },
      effects,
    };
  }

  validIdentity(input.daemonInstanceId);
  if (input.type === "connected") {
    if (
      previous.daemonInstanceId === input.daemonInstanceId &&
      (previous.phase === "live" || previous.phase === "syncing")
    ) {
      return { state: previous, effects: [] };
    }
    return beginGeneration(previous, input.daemonInstanceId);
  }

  validCounter(input.sequence, "sequence");
  if (input.type === "snapshot") validCounter(input.revision, "revision");
  if (input.type === "changed") validCounter(input.revision, "revision");

  if (previous.daemonInstanceId !== input.daemonInstanceId) {
    // Never apply a payload from another generation to retained data. A full
    // snapshot establishes the new generation directly; deltas must resync.
    if (input.type === "snapshot") {
      const retired = previous.daemonInstanceId
        ? [{ type: "retire-generation" as const, daemonInstanceId: previous.daemonInstanceId }]
        : [];
      return {
        state: {
          phase: "live",
          daemonInstanceId: input.daemonInstanceId,
          sequence: input.sequence,
          revision: input.revision,
          value: input.value,
          reason: null,
        },
        effects: retired,
      };
    }
    return beginGeneration(previous, input.daemonInstanceId);
  }

  if (input.type === "snapshot") {
    if (previous.sequence !== null && input.sequence < previous.sequence) {
      return { state: previous, effects: [] };
    }
    return {
      state: {
        phase: "live",
        daemonInstanceId: input.daemonInstanceId,
        sequence: input.sequence,
        revision: input.revision,
        value: input.value,
        reason: null,
      },
      effects: [],
    };
  }

  if (input.type === "gap") {
    if (previous.sequence !== null && input.sequence <= previous.sequence) {
      return { state: previous, effects: [] };
    }
    return {
      state: { ...previous, phase: "stale", reason: "event-gap" },
      effects: [{ type: "request-snapshot", daemonInstanceId: input.daemonInstanceId }],
    };
  }

  if (previous.sequence === null) {
    return {
      state: { ...previous, phase: "syncing", reason: "initial" },
      effects: [{ type: "request-snapshot", daemonInstanceId: input.daemonInstanceId }],
    };
  }
  if (input.sequence <= previous.sequence) {
    return { state: previous, effects: [] };
  }
  if (input.sequence !== previous.sequence + 1) {
    return {
      state: { ...previous, phase: "stale", reason: "event-gap" },
      effects: [{ type: "request-snapshot", daemonInstanceId: input.daemonInstanceId }],
    };
  }
  if (previous.revision !== null && input.revision <= previous.revision) {
    return {
      state: { ...previous, sequence: input.sequence },
      effects: [],
    };
  }
  return {
    state: {
      ...previous,
      phase: "stale",
      sequence: input.sequence,
      reason: "changed",
    },
    effects: [
      {
        type: "refresh-resource",
        daemonInstanceId: input.daemonInstanceId,
        minimumRevision: input.revision,
      },
    ],
  };
}
