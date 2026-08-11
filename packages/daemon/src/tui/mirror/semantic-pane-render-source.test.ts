import { describe, expect, it, vi } from "vitest";
import { TerminalDeliveryEnvelopeSchemaZ, type TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
} from "@tmux-ide/core";

import type { CellArrays } from "./blit.ts";
import {
  SemanticPaneReplica,
  extractTerminalCellText,
  findTerminalCellMatches,
  projectTerminalTextRow,
} from "./semantic-pane-render-source.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const pane = "pane.editor";

function negotiated() {
  const result = negotiateTerminalDelivery(
    { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
    generation,
    nonce,
  );
  if (!result.accepted) throw new Error("negotiation failed");
  return result.negotiated;
}

function seedMessages(snapshot: TerminalReplicaSnapshot, txSuffix = "3") {
  const bytes = encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
  const transactionId = `00000000-0000-4000-8000-${txSuffix.padStart(12, "0")}`;
  const envelope = TerminalDeliveryEnvelopeSchemaZ.parse({
    type: "terminal.delivery",
    workspaceName: "workspace.alpha",
    semanticPaneId: pane,
    generation,
    incarnation: `${generation}:7`,
    deliveryNonce: nonce,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-v1",
    frame: "seed",
    baseRevision: null,
    canonicalRevision: 0,
    canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: false,
  });
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes) };
}

function arrays(width: number, height: number): CellArrays {
  return {
    char: new Uint32Array(width * height),
    fg: new Uint16Array(width * height * 4),
    bg: new Uint16Array(width * height * 4),
    attributes: new Uint32Array(width * height),
  };
}

describe("SemanticPaneReplica", () => {
  it("ACKs only after retained state applies and emits one compound change", () => {
    const ack = vi.fn();
    const change = vi.fn();
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack,
      nack: vi.fn(),
      onChange: change,
    });
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(2, 1));
    snapshot.grid[0]!.cells[0]!.grapheme = "A";
    const delivery = seedMessages(snapshot);
    replica.accept(delivery.envelope);
    expect(ack).not.toHaveBeenCalled();
    for (const chunk of delivery.chunks) replica.accept(chunk);

    expect(replica.snapshot?.grid[0]!.cells[0]!.grapheme).toBe("A");
    expect(ack).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledOnce();
    expect(change.mock.calls[0]![0]).toMatchObject({
      kind: "applied",
      renderKeyChanged: true,
      rows: [0],
    });
  });

  it("echoes the failing in-flight incarnation and transaction in a NACK", () => {
    const nack = vi.fn();
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack,
    });
    const delivery = seedMessages(blankTerminalReplicaSnapshot(2, 1), "4");
    replica.accept(delivery.envelope);
    const corrupt = structuredClone(delivery.chunks[0]!);
    corrupt.bytes[0] = (corrupt.bytes[0] ?? 0) ^ 1;
    replica.accept(corrupt);
    expect(nack).toHaveBeenCalledWith(
      expect.objectContaining({
        incarnation: delivery.envelope.incarnation,
        transactionId: delivery.envelope.transactionId,
      }),
    );
  });

  it("NACKs a rejected envelope with the attempted address, never stale state", () => {
    const nack = vi.fn();
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack,
    });
    const first = seedMessages(blankTerminalReplicaSnapshot(2, 1), "40");
    const attempted = seedMessages(blankTerminalReplicaSnapshot(2, 1), "41");
    replica.accept(first.envelope);
    replica.accept({ ...attempted.envelope, incarnation: `${generation}:99` });
    expect(nack).toHaveBeenCalledWith(
      expect.objectContaining({
        incarnation: `${generation}:99`,
        transactionId: attempted.envelope.transactionId,
      }),
    );
  });

  it("treats notification and ACK throws as control faults after commit, never decode NACKs", () => {
    const nack = vi.fn();
    const controlFailure = vi.fn();
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: () => {
        throw new Error("socket closed");
      },
      nack,
      onChange: () => {
        throw new Error("surface retired");
      },
      onControlFailure: controlFailure,
    });
    const delivery = seedMessages(blankTerminalReplicaSnapshot(2, 1), "42");
    replica.accept(delivery.envelope);
    for (const chunk of delivery.chunks) replica.accept(chunk);
    expect(replica.snapshot).not.toBeNull();
    expect(nack).not.toHaveBeenCalled();
    expect(controlFailure).toHaveBeenCalledTimes(2);
  });

  it("allows exactly one retained framebuffer consumer until it releases", () => {
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
    });
    const first = {};
    const sibling = {};
    replica.blit(arrays(2, 1), 2, 1, 0, 0xffffff, 0, {
      consumerId: first,
      full: true,
      dirtyRows: [],
    });
    expect(() =>
      replica.blit(arrays(2, 1), 2, 1, 0, 0xffffff, 0, {
        consumerId: sibling,
        full: true,
        dirtyRows: [],
      }),
    ).toThrow("already has a retained surface");
    replica.releaseSurface(first);
    expect(() =>
      replica.blit(arrays(2, 1), 2, 1, 0, 0xffffff, 0, {
        consumerId: sibling,
        full: true,
        dirtyRows: [],
      }),
    ).not.toThrow();
  });

  it("projects inverse cells by swapping colors and clearing the inverse bit", () => {
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
    });
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(1, 1));
    Object.assign(snapshot.grid[0]!.cells[0]!, {
      grapheme: "X",
      foreground: { kind: "rgb", value: 0xff0000 },
      background: { kind: "rgb", value: 0x0000ff },
      attributes: 32,
    });
    const delivery = seedMessages(snapshot, "5");
    replica.accept(delivery.envelope);
    for (const chunk of delivery.chunks) replica.accept(chunk);
    const output = arrays(1, 1);
    replica.blit(output, 1, 1, 0, 0xffffff, 0, {
      full: true,
      dirtyRows: [],
    });
    expect([...output.fg.slice(0, 3)]).toEqual([0, 0, 255]);
    expect([...output.bg.slice(0, 3)]).toEqual([255, 0, 0]);
    expect(output.attributes[0]).toBe(0);
  });

  it("repaints the complete projection whenever the view is scrolled", () => {
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
    });
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(2, 2));
    snapshot.history.push(structuredClone(snapshot.grid[0]!));
    const delivery = seedMessages(snapshot, "6");
    replica.accept(delivery.envelope);
    for (const chunk of delivery.chunks) replica.accept(chunk);
    const dirtyRows: number[] = [];
    replica.blit(arrays(2, 2), 2, 2, 1, 0xffffff, 0, { full: false, dirtyRows });
    expect(dirtyRows).toEqual([0, 1]);
  });

  it("keeps Unicode text offsets mapped to terminal cells for copy and search", () => {
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(7, 1));
    const cells = snapshot.grid[0]!.cells;
    Object.assign(cells[0]!, { grapheme: "A", width: 1 });
    Object.assign(cells[1]!, { grapheme: "界", width: 2 });
    Object.assign(cells[2]!, { grapheme: "", width: 0 });
    Object.assign(cells[3]!, { grapheme: "😀", width: 2 });
    Object.assign(cells[4]!, { grapheme: "", width: 0 });
    Object.assign(cells[5]!, { grapheme: "e\u0301", width: 1 });
    Object.assign(cells[6]!, { grapheme: "B", width: 1 });

    const row = projectTerminalTextRow(snapshot.grid[0]);
    expect(row.text).toBe("A界😀e\u0301B");
    expect(row.cellTextStarts).toEqual([0, 1, 1, 2, 2, 4, 6]);
    expect(row.cellTextEnds).toEqual([1, 2, 2, 4, 4, 6, 7]);

    // Either half of a wide glyph selects the complete grapheme.
    expect(extractTerminalCellText([row], { row: 0, col: 2 }, { row: 0, col: 2 }, 64)).toBe("界");
    expect(extractTerminalCellText([row], { row: 0, col: 4 }, { row: 0, col: 4 }, 64)).toBe("😀");
    expect(extractTerminalCellText([row], { row: 0, col: 1 }, { row: 0, col: 5 }, 64)).toBe(
      "界😀e\u0301",
    );

    expect(findTerminalCellMatches([row], "界")).toEqual([{ line: 0, col: 1, columns: 2 }]);
    expect(findTerminalCellMatches([row], "😀e\u0301")).toEqual([{ line: 0, col: 3, columns: 3 }]);
  });

  it("retains the text projection for an unchanged canonical row", () => {
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
    });
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(2, 1));
    Object.assign(snapshot.grid[0]!.cells[0]!, { grapheme: "界", width: 2 });
    Object.assign(snapshot.grid[0]!.cells[1]!, { grapheme: "", width: 0 });
    const delivery = seedMessages(snapshot, "61");
    replica.accept(delivery.envelope);
    for (const chunk of delivery.chunks) replica.accept(chunk);

    expect(replica.bufferTextRows()[0]).toBe(replica.bufferTextRows()[0]);
  });

  it("never splits a UTF-8 code point when enforcing the copy byte cap", () => {
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(2, 1));
    Object.assign(snapshot.grid[0]!.cells[0]!, { grapheme: "😀", width: 2 });
    Object.assign(snapshot.grid[0]!.cells[1]!, { grapheme: "", width: 0 });
    const row = projectTerminalTextRow(snapshot.grid[0]);

    expect(extractTerminalCellText([row], { row: 0, col: 0 }, { row: 0, col: 1 }, 3)).toBe("");
    expect(extractTerminalCellText([row], { row: 0, col: 0 }, { row: 0, col: 1 }, 4)).toBe("😀");

    const combining = structuredClone(blankTerminalReplicaSnapshot(1, 1));
    Object.assign(combining.grid[0]!.cells[0]!, { grapheme: "e\u0301", width: 1 });
    const combiningRow = projectTerminalTextRow(combining.grid[0]);
    expect(extractTerminalCellText([combiningRow], { row: 0, col: 0 }, { row: 0, col: 0 }, 1)).toBe(
      "",
    );
    expect(extractTerminalCellText([combiningRow], { row: 0, col: 0 }, { row: 0, col: 0 }, 3)).toBe(
      "e\u0301",
    );
  });
});
