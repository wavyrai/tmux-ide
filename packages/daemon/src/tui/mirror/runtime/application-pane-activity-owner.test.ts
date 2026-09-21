import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InteractionReceipt } from "@tmux-ide/contracts";
import { createApplicationPaneActivityOwner } from "./application-pane-activity-owner.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

function receipt(
  sequence: number,
  phase: InteractionReceipt["phase"] = "accepted",
): InteractionReceipt {
  return {
    type: "interaction.receipt",
    sequence,
    operationId: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    origin: "sdk",
    workspaceName: "workspace.alpha",
    sourceSemanticPaneId: null,
    target: { kind: "pane", semanticPaneId: "pane.alpha" },
    operationKind: "workspace.pane.read",
    summary: { operationKind: "workspace.pane.read", observedOnly: true },
    proof: null,
    at: new Date().toISOString(),
    resourceRevision: null,
    phase,
  };
}
function rig() {
  let generation = 1;
  let lastObservedReceipt: InteractionReceipt | null = null;
  const listeners = new Map<string, Set<() => void>>();
  const client = {
    getSnapshot: () => ({ generation, operations: { lastObservedReceipt } }),
    subscribe(scope: string, listener: () => void) {
      const bucket = listeners.get(scope) ?? new Set();
      bucket.add(listener);
      listeners.set(scope, bucket);
      return () => bucket.delete(listener);
    },
  };
  let dispose!: () => void;
  const owner = createRoot((cleanup) => {
    dispose = cleanup;
    const [host, setHost] = createSignal({
      status: "live",
      client,
    } as unknown as OpenTuiGenerationHostSnapshot);
    return { activity: createApplicationPaneActivityOwner(host), setHost };
  });
  return {
    ...owner,
    dispose,
    listeners,
    emit(next: InteractionReceipt) {
      lastObservedReceipt = next;
      for (const listener of listeners.get("operations") ?? []) listener();
    },
    restart() {
      generation++;
      lastObservedReceipt = null;
      for (const listener of listeners.get("lifecycle") ?? []) listener();
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("shared pane activity", () => {
  it("keeps bounded receipt history after transient labels expire and clears it on generation replacement", async () => {
    vi.useFakeTimers();
    const r = rig();
    await Promise.resolve();
    try {
      for (let sequence = 1; sequence <= 80; sequence++) r.emit(receipt(sequence));
      expect(r.activity.activity()).toHaveLength(64);
      expect(r.activity.activity()[0]?.sequence).toBe(80);
      expect(r.activity().has("pane.alpha")).toBe(true);
      await vi.advanceTimersByTimeAsync(3_201);
      expect(r.activity().size).toBe(0);
      expect(r.activity.activity()).toHaveLength(64);
      r.restart();
      expect(r.activity.activity()).toEqual([]);
      expect(r.activity().size).toBe(0);
    } finally {
      r.dispose();
    }
    expect([...r.listeners.values()].every((bucket) => bucket.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("updates one operation in place and retains replay without making an old read look live", async () => {
    vi.useFakeTimers();
    const r = rig();
    await Promise.resolve();
    try {
      const accepted = receipt(1);
      r.emit(accepted);
      r.emit({
        ...accepted,
        sequence: 2,
        phase: "observed",
        proof: {
          operationKind: "workspace.pane.read",
          observed: true,
          semanticPaneId: "pane.alpha",
        },
      });
      expect(r.activity.activity()).toHaveLength(1);
      expect(r.activity.activity()[0]?.phase).toBe("observed");
      r.emit({ ...receipt(3), at: new Date(Date.now() - 10_000).toISOString() });
      expect(r.activity.activity()).toHaveLength(2);
      expect(r.activity().size).toBe(0);
    } finally {
      r.dispose();
    }
  });
});
