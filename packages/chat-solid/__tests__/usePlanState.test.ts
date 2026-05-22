import { createRoot, createSignal, type Accessor } from "solid-js";
import { describe, expect, it } from "vitest";
import { usePlanState } from "../src/hooks/usePlanState";
import type { PlanEntry } from "../src/types";

async function tick(): Promise<void> {
  await Promise.resolve();
}

describe("usePlanState", () => {
  it("cycles local status overrides", async () => {
    let plan!: ReturnType<typeof usePlanState>;
    let dispose!: () => void;
    createRoot((rootDispose) => {
      dispose = rootDispose;
      const [entries] = createSignal<PlanEntry[]>([{ content: "Inspect", status: "pending" }]);
      plan = usePlanState(entries as Accessor<PlanEntry[]>);
    });
    await tick();

    plan.toggleEntry(0);
    expect(plan.entries()[0]?.localStatus).toBe("in_progress");
    plan.toggleEntry(0);
    expect(plan.entries()[0]?.localStatus).toBe("completed");
    plan.toggleEntry(0);
    expect(plan.entries()[0]?.localStatus).toBe("pending");
    dispose();
  });

  it("replaces agent overrides on a new agent plan while preserving user steps", async () => {
    let plan!: ReturnType<typeof usePlanState>;
    let setEntries!: (entries: PlanEntry[]) => void;
    let dispose!: () => void;
    createRoot((rootDispose) => {
      dispose = rootDispose;
      const [entries, setAgentEntries] = createSignal<PlanEntry[]>([
        { content: "First", status: "pending" },
      ]);
      setEntries = setAgentEntries;
      plan = usePlanState(entries as Accessor<PlanEntry[]>);
    });
    await tick();

    plan.toggleEntry(0);
    plan.addUserEntry("My extra step");
    expect(plan.entries().map((entry) => entry.content)).toEqual(["First", "My extra step"]);

    setEntries([{ content: "Replacement", status: "completed" }]);
    await tick();

    expect(plan.entries()).toMatchObject([
      { content: "Replacement", status: "completed", origin: "agent" },
      { content: "My extra step", status: "pending", origin: "user" },
    ]);
    expect(plan.entries()[0]?.localStatus).toBeUndefined();
    dispose();
  });

  it("keeps local overrides when the same agent plan is re-emitted by the UI layer", async () => {
    let plan!: ReturnType<typeof usePlanState>;
    let setEntries!: (entries: PlanEntry[]) => void;
    let dispose!: () => void;
    createRoot((rootDispose) => {
      dispose = rootDispose;
      const [entries, setAgentEntries] = createSignal<PlanEntry[]>([
        { content: "Inspect", status: "pending" },
      ]);
      setEntries = setAgentEntries;
      plan = usePlanState(entries as Accessor<PlanEntry[]>);
    });
    await tick();

    plan.toggleEntry(0);
    setEntries([{ content: "Inspect", status: "pending" }]);
    await tick();

    expect(plan.entries()[0]?.localStatus).toBe("in_progress");
    dispose();
  });
});
