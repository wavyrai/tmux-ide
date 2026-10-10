import { describe, expect, it, vi } from "vitest";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import {
  SessionRuntimeTerminalDeliveryHub,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";
const generation = "00000000-0000-4000-8000-000000000001";
const offer = {
  protocolVersions: [1],
  encodings: ["semantic-compact-v1"],
  richPlacements: false,
} as const;
function fixture(session: string) {
  let listener: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
  const subscribeSource = vi.fn(async (next: typeof listener) => {
    listener = next;
    return { generation, semanticPaneId: "pane-a", close: async () => {} };
  });
  const source: TerminalDeliverySourceOwner = { subscribeSource };
  const hub = new SessionRuntimeTerminalDeliveryHub(generation, session, () => source);
  const snapshot = blankTerminalReplicaSnapshot(2, 1);
  const emit = (revision: number) => {
    const next = { ...snapshot, cursor: { ...snapshot.cursor, x: revision % 2 } };
    listener?.({
      type: "terminal.seed",
      workspaceName: session,
      semanticPaneId: "pane-a",
      generation,
      incarnation: generation + ":0",
      revision,
      cols: 2,
      rows: 1,
      stateHash: hashTerminalReplicaSnapshot(next),
      hashAlgorithm: "fnv1a64-v1",
      snapshot: next,
    });
  };
  return { hub, emit, subscribeSource };
}
const envelope = (messages: TerminalDeliveryServerMessage[]) =>
  messages.findLast((m): m is TerminalDeliveryEnvelope => m.type === "terminal.delivery")!;
const ack = (e: TerminalDeliveryEnvelope) => ({
  type: "terminal.delivery.ack" as const,
  workspaceName: e.workspaceName,
  semanticPaneId: e.semanticPaneId,
  generation: e.generation,
  incarnation: e.incarnation,
  deliveryNonce: e.deliveryNonce,
  transactionId: e.transactionId,
  canonicalRevision: e.canonicalRevision,
  canonicalStateHash: e.canonicalStateHash,
  representationHash: e.representationHash,
});
const nack = (e: TerminalDeliveryEnvelope) => ({
  type: "terminal.delivery.nack" as const,
  workspaceName: e.workspaceName,
  semanticPaneId: e.semanticPaneId,
  generation: e.generation,
  incarnation: e.incarnation,
  deliveryNonce: e.deliveryNonce,
  transactionId: e.transactionId,
  reason: "hash-mismatch" as const,
  appliedRevision: e.canonicalRevision - 1,
});
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
describe("delivery workspace address", () => {
  it.each(["ordinary", "session with spaces ", "开发 — workspace "])(
    "keeps %s native identity separate from two delivery aliases",
    async (session) => {
      const f = fixture(session);
      const a: TerminalDeliveryServerMessage[] = [],
        b: TerminalDeliveryServerMessage[] = [];
      try {
        const ca = await f.hub.open(
          "a",
          "pane-a",
          offer,
          (m) => {
            a.push(m);
          },
          undefined,
          "workspace-a",
        );
        const cb = await f.hub.open(
          "b",
          "pane-a",
          offer,
          (m) => {
            b.push(m);
          },
          undefined,
          "workspace-b",
        );
        f.emit(0);
        await settle();
        expect(envelope(a)?.workspaceName).toBe("workspace-a");
        expect(envelope(b)?.workspaceName).toBe("workspace-b");
        expect(envelope(a).canonicalStateHash).toBe(envelope(b).canonicalStateHash);
        expect(envelope(a).representationHash).toBe(envelope(b).representationHash);
        expect(envelope(a).deliveryNonce).not.toBe(envelope(b).deliveryNonce);
        ca.ack(ack(envelope(a)));
        cb.ack(ack(envelope(b)));
        f.emit(1);
        await settle();
        expect(envelope(a).canonicalRevision).toBe(1);
        expect(envelope(b).canonicalRevision).toBe(1);
        const before = envelope(b).transactionId;
        cb.nack(nack(envelope(b)));
        await settle();
        expect(envelope(b).transactionId).not.toBe(before);
        expect(envelope(b).frame).toBe("seed");
        ca.ack({ ...ack(envelope(a)), workspaceName: "workspace-b" });
        await settle();
        expect(a.some((m) => m.type === "terminal.delivery.fault")).toBe(true);
        cb.ack(ack(envelope(b)));
        f.emit(2);
        await settle();
        expect(envelope(b).canonicalRevision).toBe(2);
        cb.nack({ ...nack(envelope(b)), workspaceName: "workspace-a" });
        await settle();
        expect(b.some((m) => m.type === "terminal.delivery.fault")).toBe(true);
      } finally {
        await f.hub.close();
      }
    },
  );
  it("rejects invalid default or explicit aliases before subscribing, but keeps valid direct defaults", async () => {
    const invalid = fixture("raw session ");
    const valid = fixture("workspace");
    try {
      await expect(invalid.hub.open("a", "pane-a", offer, () => {})).rejects.toThrow();
      await expect(
        valid.hub.open("a", "pane-a", offer, () => {}, undefined, "bad address "),
      ).rejects.toThrow();
      expect(invalid.subscribeSource).not.toHaveBeenCalled();
      expect(valid.subscribeSource).not.toHaveBeenCalled();
      const messages: TerminalDeliveryServerMessage[] = [];
      await valid.hub.open("a", "pane-a", offer, (m) => {
        messages.push(m);
      });
      valid.emit(0);
      await settle();
      expect(envelope(messages).workspaceName).toBe("workspace");
    } finally {
      await invalid.hub.close();
      await valid.hub.close();
    }
  });
});
