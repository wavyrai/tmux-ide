import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalReplicaSnapshot,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import {
  decodeCompactSemanticTerminalUpdate,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  TerminalDeliveryAssembler,
  createTerminalDeliveryClientState,
  admitTerminalDeliveryEnvelope,
  admitTerminalDeliveryChunk,
  completeTerminalDelivery,
  commitTerminalDelivery,
} from "@tmux-ide/core";
import {
  SessionRuntimeTerminalDeliveryHub,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";
const generation = "00000000-0000-4000-8000-000000000001";
class Owner implements TerminalDeliverySourceOwner {
  listener: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
  async subscribeSource(listener: (update: CanonicalTerminalReplicaUpdate) => void) {
    this.listener = listener;
    return { generation, semanticPaneId: "pane", close: async () => {} };
  }
  emit(snapshot: TerminalReplicaSnapshot, revision: number, incarnation = `${generation}:0`) {
    this.listener!({
      type: "terminal.seed",
      workspaceName: "w",
      semanticPaneId: "pane",
      generation,
      incarnation,
      revision,
      cols: snapshot.cols,
      rows: snapshot.rows,
      snapshot,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
    });
  }
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
};
function initial() {
  const s = structuredClone(blankTerminalReplicaSnapshot(4, 2));
  s.history = Array.from({ length: 20 }, (_, i) => ({
    ...s.grid[0]!,
    cells: s.grid[0]!.cells.map((c, j) => ({ ...c, grapheme: j === 0 ? String(i % 10) : " " })),
  }));
  return s;
}
function commit(
  state: ReturnType<typeof createTerminalDeliveryClientState>,
  e: TerminalDeliveryEnvelope,
  m: TerminalDeliveryServerMessage[],
) {
  let admitted = admitTerminalDeliveryEnvelope(state, e);
  const a = new TerminalDeliveryAssembler(e);
  for (const c of m)
    if (c.type === "terminal.delivery.chunk" && c.transactionId === e.transactionId) {
      admitted = admitTerminalDeliveryChunk(admitted, c);
      a.write(c);
    }
  return commitTerminalDelivery(admitted, completeTerminalDelivery(admitted, a));
}
function payload(e: TerminalDeliveryEnvelope, m: TerminalDeliveryServerMessage[]) {
  const a = new TerminalDeliveryAssembler(e);
  for (const c of m)
    if (c.type === "terminal.delivery.chunk" && c.transactionId === e.transactionId) a.write(c);
  return e.encoding === "semantic-compact-v1"
    ? decodeCompactSemanticTerminalUpdate(a.complete())
    : JSON.parse(new TextDecoder().decode(a.complete()));
}
describe.each(["semantic-v1", "semantic-compact-v1"] as const)(
  "coalesced exact %s delivery",
  (encoding) => {
    it.each([
      "append",
      "changed-history",
      "trim",
      "geometry",
      "reflow",
      "incarnation",
      "comparison-budget",
      "appended-budget",
    ] as const)("preserves exact skipped state for %s", async (kind) => {
      const owner = new Owner(),
        hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => owner),
        messages: TerminalDeliveryServerMessage[] = [];
      const c = await hub.open(
        "client",
        "pane",
        { protocolVersions: [1], encodings: [encoding], richPlacements: false },
        (m) => {
          messages.push(m);
        },
      );
      try {
        const baseline = initial();
        if (kind === "comparison-budget")
          baseline.history = Array.from({ length: 2050 }, (_, i) =>
            structuredClone(baseline.history[i % 20]!),
          );
        const originalHistoryLength = baseline.history.length;
        owner.emit(baseline, 0);
        await settle();
        await vi.waitFor(() =>
          expect(messages.some((m) => m.type === "terminal.delivery.chunk")).toBe(true),
        );
        const first = messages[0] as TerminalDeliveryEnvelope;
        const seeded = commit(
          createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
          first,
          messages,
        );
        const target = structuredClone(baseline);
        target.grid[0]!.cells[0]!.grapheme = "界";
        target.grid[0]!.cells[0]!.width = 2;
        target.grid[0]!.cells[1]!.grapheme = "";
        target.grid[0]!.cells[1]!.width = 0;
        target.grid[0]!.cells[2]!.grapheme = "e\u0301";
        target.grid[0]!.cells[2]!.foreground = { kind: "indexed", index: 17 };
        target.cursor.x = 3;
        target.modes.bracketedPaste = true;
        target.history.push(structuredClone(target.grid[0]!));
        if (kind === "appended-budget")
          target.history.push(
            ...Array.from({ length: 2050 }, () => structuredClone(target.grid[1]!)),
          );
        if (kind === "changed-history") target.history[0]!.cells[0]!.grapheme = "X";
        if (kind === "trim") target.history.shift();
        if (kind === "geometry") {
          target.cols = 5;
          for (const row of [...target.grid, ...target.history])
            row.cells.push({ ...baseline.grid[1]!.cells[0]! });
        }
        if (kind === "reflow") target.history[0]!.wrapped = !target.history[0]!.wrapped;
        owner.emit(baseline, 1);
        owner.emit(target, 2, kind === "incarnation" ? `${generation}:1` : undefined);
        await settle();
        expect(messages.filter((m) => m.type === "terminal.delivery")).toHaveLength(1);
        await vi.waitFor(() => expect(hub.convergenceSnapshot().panes[0]?.revision).toBe(2));
        c.ack(seeded.ack);
        await settle();
        await vi.waitFor(() =>
          expect(messages.filter((m) => m.type === "terminal.delivery").at(-1)).toMatchObject({
            canonicalRevision: 2,
          }),
        );
        const e = messages
          .filter((m): m is TerminalDeliveryEnvelope => m.type === "terminal.delivery")
          .at(-1)!;
        expect(e.canonicalRevision).toBe(2);
        expect(e.canonicalStateHash).toBe(hashTerminalReplicaSnapshot(target));
        expect(e.frame).toBe(kind === "append" ? "patch" : "seed");
        if (kind === "append") {
          expect(e.baseRevision).toBe(0);
          expect(payload(e, messages).patch.historyDelta).toEqual({
            trim: 0,
            append: [target.history.at(-1)],
          });
          expect(payload(e, messages).patch.rows).toEqual([{ index: 0, row: target.grid[0] }]);
        }
        const result = commit(seeded.state, e, messages);
        expect(result.state.canonicalSnapshot).toEqual(target);
        expect(baseline.history).toHaveLength(originalHistoryLength);
        expect(baseline.grid[0]!.cells[0]!.grapheme).toBe(" ");
        c.ack(result.ack);
        await settle();
        expect(hub.metrics().inFlight).toBe(0);
        expect(hub.convergenceSnapshot().clients[0]?.baselineRevision).toBe(2);
      } finally {
        await c.close();
        await hub.close();
      }
    });
  },
);
