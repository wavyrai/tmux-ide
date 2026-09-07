import { describe, expect, it } from "bun:test";
import type { InteractionReceipt } from "@tmux-ide/contracts";
import { defaultGenerationBoundClock } from "./generation-bound-store.ts";
import { createWorkspaceClientOperationLedger } from "./workspace-client-operations.ts";

describe("shared operation observation", () => {
  it("publishes external receipts without inventing local pending operations and fences replay/generation", () => {
    let changes = 0;
    const ledger = createWorkspaceClientOperationLedger({
      clock: defaultGenerationBoundClock,
      initialGeneration: 1,
      onChange: () => changes++,
    });
    const receipt: InteractionReceipt = {
      type: "interaction.receipt",
      sequence: 20,
      operationId: "10000000-0000-4000-8000-000000000001",
      origin: "external",
      workspaceName: "alpha",
      sourceSemanticPaneId: null,
      target: { kind: "pane", semanticPaneId: "pane.alpha" },
      operationKind: "workspace.pane.send",
      phase: "observed",
      summary: { operationKind: "workspace.pane.send", observedOnly: true },
      proof: { operationKind: "workspace.pane.send", observed: true, semanticPaneId: "pane.alpha" },
      at: new Date().toISOString(),
      resourceRevision: null,
    };
    ledger.observeReceipt(receipt, 1);
    expect(ledger.receipt(receipt, 1)).toBe(false);
    expect(ledger.getSnapshot()).toMatchObject({
      lastObservedReceipt: receipt,
      lastReceipt: null,
      pending: [],
      terminalOperationIds: [],
    });
    ledger.observeReceipt(receipt, 1);
    ledger.observeReceipt({ ...receipt, sequence: 19 }, 1);
    expect(changes).toBe(1);
    ledger.replaceGeneration(2);
    ledger.observeReceipt({ ...receipt, sequence: 21 }, 1);
    expect(ledger.getSnapshot().lastObservedReceipt).toBeNull();
    ledger.observeReceipt({ ...receipt, sequence: 1 }, 2);
    expect(ledger.getSnapshot().lastObservedReceipt?.sequence).toBe(1);
    ledger.dispose();
  });
});
