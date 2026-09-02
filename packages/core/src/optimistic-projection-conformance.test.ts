import { describe, expect, it } from "vitest";
import {
  runOptimisticProjectionConformance,
  type OptimisticConformanceFixture,
} from "./optimistic-projection-conformance.ts";

interface Intent {
  readonly client: "react" | "opentui" | "sdk";
  readonly delta: number;
}
const options = {
  predict: (value: number, intent: Intent) => value + intent.delta,
  terminalHistoryLimit: 8,
};
const fixture: OptimisticConformanceFixture<number, Intent> = {
  name: "ordered-interleaving-receipts-and-generation",
  committed: { generation: "daemon-a", revision: 7, value: 10 },
  commands: [
    {
      type: "enqueue",
      operationId: "react-1",
      intent: { client: "react", delta: 2 },
      acceptedAtMs: 1,
      deadlineAtMs: 100,
    },
    {
      type: "enqueue",
      operationId: "tui-1",
      intent: { client: "opentui", delta: 3 },
      acceptedAtMs: 2,
      deadlineAtMs: 100,
    },
    {
      type: "enqueue",
      operationId: "sdk-1",
      intent: { client: "sdk", delta: -1 },
      acceptedAtMs: 3,
      deadlineAtMs: 100,
    },
    { type: "receipt", operationId: "tui-1", phase: "observed" },
    { type: "receipt", operationId: "tui-1", phase: "rejected" },
    {
      type: "replace",
      committed: { generation: "daemon-b", revision: 0, value: 12 },
      observedOperationIds: ["react-1"],
      nowMs: 10,
    },
    { type: "receipt", operationId: "sdk-1", phase: "observed" },
    { type: "receipt", operationId: "react-1", phase: "observed" },
  ],
};
describe("React/OpenTUI/SDK optimistic projection conformance", () => {
  it("produces identical ordered observations for each adapter label", () => {
    const traces = (["react", "opentui", "sdk"] as const).map(() =>
      runOptimisticProjectionConformance(fixture, options),
    );
    expect(traces[1]).toEqual(traces[0]);
    expect(traces[2]).toEqual(traces[0]);
    expect(traces[0]).toContainEqual(
      expect.objectContaining({ derived: 14, pending: ["react-1", "tui-1", "sdk-1"] }),
    );
    expect(traces[0]).toContainEqual(
      expect.objectContaining({
        generation: "daemon-b",
        revision: 0,
        derived: 11,
        pending: ["sdk-1"],
      }),
    );
    expect(traces[0]!.at(-1)).toEqual(expect.objectContaining({ derived: 12, pending: [] }));
  });
  it("does not republish duplicate or reordered terminal receipts", () => {
    expect(runOptimisticProjectionConformance(fixture, options)).toHaveLength(7);
  });
});
