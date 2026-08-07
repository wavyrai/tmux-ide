import { describe, expect, it } from "bun:test";
import {
  advanceResourceReplica,
  initialResourceReplica,
  type ResourceReplicaState,
} from "./resource-replica.ts";

const GENERATION_A = "daemon-a";
const GENERATION_B = "daemon-b";

function live(value = "layout-a"): ResourceReplicaState<string> {
  return {
    phase: "live",
    daemonInstanceId: GENERATION_A,
    sequence: 10,
    revision: 4,
    value,
    reason: null,
  };
}

describe("resource replica", () => {
  it("requests one initial snapshot and retains the last value through reconnect", () => {
    const connected = advanceResourceReplica(initialResourceReplica<string>(), {
      type: "connected",
      daemonInstanceId: GENERATION_A,
    });
    expect(connected.state).toMatchObject({ phase: "syncing", value: null });
    expect(connected.effects).toEqual([
      { type: "request-snapshot", daemonInstanceId: GENERATION_A },
    ]);

    const disconnected = advanceResourceReplica(live(), { type: "disconnected" });
    expect(disconnected.state).toMatchObject({
      phase: "stale",
      value: "layout-a",
      reason: "disconnected",
    });
    const resumed = advanceResourceReplica(disconnected.state, {
      type: "connected",
      daemonInstanceId: GENERATION_A,
    });
    expect(resumed.state.value).toBe("layout-a");
    expect(resumed.effects).toEqual([{ type: "request-snapshot", daemonInstanceId: GENERATION_A }]);
  });

  it("retires generation-scoped authority before syncing a replacement daemon", () => {
    const transition = advanceResourceReplica(live(), {
      type: "connected",
      daemonInstanceId: GENERATION_B,
    });
    expect(transition.state).toMatchObject({
      phase: "syncing",
      daemonInstanceId: GENERATION_B,
      value: "layout-a",
      reason: "generation-changed",
    });
    expect(transition.effects).toEqual([
      { type: "retire-generation", daemonInstanceId: GENERATION_A },
      { type: "request-snapshot", daemonInstanceId: GENERATION_B },
    ]);
  });

  it("refreshes only for a contiguous event carrying a newer resource revision", () => {
    const transition = advanceResourceReplica(live(), {
      type: "changed",
      daemonInstanceId: GENERATION_A,
      sequence: 11,
      revision: 5,
      causeOperationId: "operation-a",
    });
    expect(transition.state).toMatchObject({ phase: "stale", sequence: 11, reason: "changed" });
    expect(transition.effects).toEqual([
      {
        type: "refresh-resource",
        daemonInstanceId: GENERATION_A,
        minimumRevision: 5,
      },
    ]);

    const duplicate = advanceResourceReplica(live(), {
      type: "changed",
      daemonInstanceId: GENERATION_A,
      sequence: 10,
      revision: 5,
    });
    expect(duplicate).toEqual({ state: live(), effects: [] });
  });

  it("requests a full snapshot when any event sequence is missing", () => {
    const transition = advanceResourceReplica(live(), {
      type: "changed",
      daemonInstanceId: GENERATION_A,
      sequence: 13,
      revision: 5,
    });
    expect(transition.state).toMatchObject({ phase: "stale", reason: "event-gap" });
    expect(transition.effects).toEqual([
      { type: "request-snapshot", daemonInstanceId: GENERATION_A },
    ]);
  });

  it("allows multiple clients to converge independently on one shared snapshot", () => {
    let left = initialResourceReplica<{ windows: number }>();
    let right = initialResourceReplica<{ windows: number }>();
    for (const set of [
      (value: typeof left) => (left = value),
      (value: typeof right) => (right = value),
    ]) {
      const connected = advanceResourceReplica(initialResourceReplica<{ windows: number }>(), {
        type: "connected",
        daemonInstanceId: GENERATION_A,
      });
      const snapshot = advanceResourceReplica(connected.state, {
        type: "snapshot",
        daemonInstanceId: GENERATION_A,
        sequence: 7,
        revision: 3,
        value: { windows: 6 },
      });
      set(snapshot.state);
    }
    expect(left).toEqual(right);

    left = advanceResourceReplica(left, {
      type: "disconnected",
    }).state;
    expect(left.phase).toBe("stale");
    expect(right.phase).toBe("live");
    expect(left.value).toEqual(right.value);
  });

  it("refuses malformed counters and identities at the host-neutral boundary", () => {
    expect(() =>
      advanceResourceReplica(initialResourceReplica(), {
        type: "connected",
        daemonInstanceId: "",
      }),
    ).toThrow("daemonInstanceId");
    expect(() =>
      advanceResourceReplica(live(), {
        type: "changed",
        daemonInstanceId: GENERATION_A,
        sequence: -1,
        revision: 5,
      }),
    ).toThrow("sequence");
  });
});
