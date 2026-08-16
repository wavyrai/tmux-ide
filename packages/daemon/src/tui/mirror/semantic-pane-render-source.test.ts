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
  SemanticTerminalRenderSource,
  extractTerminalCellText,
  findTerminalCellMatches,
  projectTerminalTextRow,
  type SemanticPaneReplicaChange,
} from "./semantic-pane-render-source.ts";
import { installTuiPerformanceEventSink } from "./performance-events.ts";
import { publishSemanticPaneChange } from "./runtime/semantic-pane-publication.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const pane = "pane.editor";

function negotiated(richPlacements = false) {
  const result = negotiateTerminalDelivery(
    { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements },
    generation,
    nonce,
  );
  if (!result.accepted) throw new Error("negotiation failed");
  return result.negotiated;
}

function seedMessages(
  snapshot: TerminalReplicaSnapshot,
  txSuffix = "3",
  performanceTraceId?: string,
  richPlacements = false,
) {
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
    ...(performanceTraceId ? { performanceTraceId } : {}),
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
    richPlacements,
  });
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes) };
}

function patchMessages(
  previous: TerminalReplicaSnapshot,
  revision: number,
  txSuffix: string,
  performanceTraceId?: string,
  placements?: TerminalReplicaSnapshot["placements"],
) {
  const next = structuredClone(previous);
  next.cursor.x = revision % next.cols;
  if (placements !== undefined) next.placements = structuredClone(placements);
  const payload = {
    frame: "patch" as const,
    baseRevision: revision - 1,
    revision,
    patch: {
      rows: [],
      cursor: next.cursor,
      ...(placements !== undefined ? { placements: next.placements } : {}),
    },
  };
  const bytes = encodeSemanticTerminalUpdate(payload);
  const transactionId = `00000000-0000-4000-8000-${txSuffix.padStart(12, "0")}`;
  const envelope = TerminalDeliveryEnvelopeSchemaZ.parse({
    type: "terminal.delivery",
    workspaceName: "workspace.alpha",
    semanticPaneId: pane,
    generation,
    incarnation: `${generation}:7`,
    deliveryNonce: nonce,
    transactionId,
    ...(performanceTraceId ? { performanceTraceId } : {}),
    protocolVersion: 1,
    encoding: "semantic-v1",
    frame: "patch",
    baseRevision: revision - 1,
    canonicalRevision: revision,
    canonicalStateHash: hashTerminalReplicaSnapshot(next),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: placements !== undefined || previous.placements.length > 0,
  });
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes), next };
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
  it("keeps independent GUI/TUI consumers converged on one canonical revision and hash", () => {
    const changes = [vi.fn(), vi.fn()];
    const replicas = changes.map(
      (onChange) =>
        new SemanticPaneReplica({
          negotiated: negotiated(),
          workspaceName: "workspace.alpha",
          semanticPaneId: pane,
          ack: vi.fn(),
          nack: vi.fn(),
          onChange,
        }),
    );
    const initial = blankTerminalReplicaSnapshot(4, 2);
    const seed = seedMessages(initial, "401");
    for (const replica of replicas) {
      replica.accept(seed.envelope);
      for (const chunk of seed.chunks) replica.accept(chunk);
    }
    const patch = patchMessages(initial, 1, "402");
    for (const replica of replicas) {
      replica.accept(patch.envelope);
      for (const chunk of patch.chunks) replica.accept(chunk);
    }

    const snapshots = replicas.map((replica) => replica.canonicalSnapshot());
    expect(snapshots.map((snapshot) => snapshot?.snapshot)).toEqual([patch.next, patch.next]);
    expect(
      snapshots.map((snapshot) =>
        snapshot ? hashTerminalReplicaSnapshot(snapshot.snapshot) : null,
      ),
    ).toEqual([patch.envelope.canonicalStateHash, patch.envelope.canonicalStateHash]);
    expect(replicas.map((replica) => replica.version)).toEqual([2, 2]);
    expect(changes.map((change) => change.mock.calls.length)).toEqual([2, 2]);
  });

  it("classifies a same-incarnation cursor packet as content-only publication", () => {
    const onChange = vi.fn();
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
      onChange,
    });
    const initial = blankTerminalReplicaSnapshot(4, 2);
    const seed = seedMessages(initial, "403");
    replica.accept(seed.envelope);
    for (const chunk of seed.chunks) replica.accept(chunk);
    onChange.mockClear();

    const patch = patchMessages(initial, 1, "404");
    replica.accept(patch.envelope);
    for (const chunk of patch.chunks) replica.accept(chunk);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "applied",
        cursorChanged: true,
        renderKeyChanged: false,
        scrollbackChanged: false,
        runtimeFactsChanged: false,
        version: 2,
      }),
    );
  });

  it("wakes structure exactly once when rich placements appear or disappear", () => {
    const publishContentVersion = vi.fn();
    const publishStructure = vi.fn();
    const changes: SemanticPaneReplicaChange[] = [];
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(true),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
      onChange: (change) => {
        changes.push(change);
        publishSemanticPaneChange(change, { publishContentVersion, publishStructure });
      },
    });
    const initial = blankTerminalReplicaSnapshot(8, 4);
    const seed = seedMessages(initial, "405", undefined, true);
    replica.accept(seed.envelope);
    for (const chunk of seed.chunks) replica.accept(chunk);
    publishContentVersion.mockClear();
    publishStructure.mockClear();

    const placement = {
      id: "markdown",
      kind: "markdown",
      row: 1,
      column: 1,
      columns: 4,
      rows: 2,
      contentDigest: "sha256:markdown",
    };
    const added = patchMessages(initial, 1, "406", undefined, [placement]);
    replica.accept(added.envelope);
    for (const chunk of added.chunks) replica.accept(chunk);

    expect(changes.at(-1)).toMatchObject({ kind: "applied", placementsChanged: true });
    expect(publishContentVersion).toHaveBeenCalledOnce();
    expect(publishStructure).toHaveBeenCalledOnce();

    publishContentVersion.mockClear();
    publishStructure.mockClear();
    const ordinary = patchMessages(added.next, 2, "407");
    replica.accept(ordinary.envelope);
    for (const chunk of ordinary.chunks) replica.accept(chunk);
    expect(changes.at(-1)).toMatchObject({ kind: "applied", placementsChanged: false });
    expect(publishContentVersion).toHaveBeenCalledOnce();
    expect(publishStructure).not.toHaveBeenCalled();

    publishContentVersion.mockClear();
    publishStructure.mockClear();
    const removed = patchMessages(ordinary.next, 3, "408", undefined, []);
    replica.accept(removed.envelope);
    for (const chunk of removed.chunks) replica.accept(chunk);
    expect(changes.at(-1)).toMatchObject({ kind: "applied", placementsChanged: true });
    expect(publishContentVersion).toHaveBeenCalledOnce();
    expect(publishStructure).toHaveBeenCalledOnce();
  });

  it("makes trace authority available to a synchronous paint subscriber", () => {
    const traceId = "00000000-0000-4000-8000-000000000097";
    let paintedTrace: ReturnType<SemanticPaneReplica["takePaintTrace"]> = null;
    let replica!: SemanticPaneReplica;
    replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
      onChange: (change) => {
        if (change.kind === "applied") paintedTrace = replica.takePaintTrace();
      },
    });
    const delivery = seedMessages(blankTerminalReplicaSnapshot(2, 1), "97", traceId);
    replica.accept(delivery.envelope);
    for (const chunk of delivery.chunks) replica.accept(chunk);

    expect(paintedTrace).toEqual({
      traceId,
      generation,
      incarnation: `${generation}:7`,
      semanticPaneId: pane,
      revision: 0,
      stateHash: "a1d4bef4c2291a16",
    });
  });

  it("publishes delivery queue, lag, and parse measurements only while the HUD sink is installed", () => {
    const sink = {
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
    };
    const remove = installTuiPerformanceEventSink(sink);
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
    });
    const delivery = seedMessages(blankTerminalReplicaSnapshot(2, 1), "300");
    replica.accept(delivery.envelope);
    for (const chunk of delivery.chunks) replica.accept(chunk);

    expect(sink.terminalDelivery).toHaveBeenCalledOnce();
    expect(sink.terminalDelivery.mock.calls[0]![0]).toMatchObject({
      queuePeak: 1,
      queueCapacity: 1,
      settledQueueDepth: 0,
      revisionLagPeak: 1,
      reseed: false,
    });
    expect(sink.terminalDelivery.mock.calls[0]![0].parseMs).toBeGreaterThanOrEqual(0);

    remove();
    const second = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
    });
    const silent = seedMessages(blankTerminalReplicaSnapshot(2, 1), "301");
    second.accept(silent.envelope);
    for (const chunk of silent.chunks) second.accept(chunk);
    expect(sink.terminalDelivery).toHaveBeenCalledOnce();
  });

  it("carries daemon trace authority to exactly one real framebuffer blit", () => {
    const traceId = "00000000-0000-4000-8000-000000000099";
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
    });
    const source = new SemanticTerminalRenderSource();
    source.set(replica);
    const delivery = seedMessages(blankTerminalReplicaSnapshot(2, 1), "98", traceId);
    replica.accept(delivery.envelope);
    for (const chunk of delivery.chunks) replica.accept(chunk);
    const options = { full: true, dirtyRows: [] as number[] };

    expect(source.blitPane(pane, arrays(2, 1), 2, 1, 0, 0xffffff, 0, options)).toEqual({
      traceId,
      generation,
      incarnation: `${generation}:7`,
      semanticPaneId: pane,
      revision: 0,
      stateHash: "a1d4bef4c2291a16",
    });
    expect(
      source.blitPane(pane, arrays(2, 1), 2, 1, 0, 0xffffff, 0, {
        full: true,
        dirtyRows: [],
      }),
    ).toBeNull();
  });

  it("keeps the latest traced delivery through later untraced state until paint", () => {
    const traceA = "00000000-0000-4000-8000-000000000094";
    const traceB = "00000000-0000-4000-8000-000000000095";
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack: vi.fn(),
      nack: vi.fn(),
    });
    const source = new SemanticTerminalRenderSource();
    source.set(replica);
    const initial = blankTerminalReplicaSnapshot(2, 1);
    const seed = seedMessages(initial, "401");
    replica.accept(seed.envelope);
    for (const chunk of seed.chunks) replica.accept(chunk);
    const first = patchMessages(initial, 1, "402", traceA);
    replica.accept(first.envelope);
    for (const chunk of first.chunks) replica.accept(chunk);
    const latest = patchMessages(first.next, 2, "403", traceB);
    replica.accept(latest.envelope);
    for (const chunk of latest.chunks) replica.accept(chunk);
    const untraced = patchMessages(latest.next, 3, "404");
    replica.accept(untraced.envelope);
    for (const chunk of untraced.chunks) replica.accept(chunk);

    expect(
      source.blitPane(pane, arrays(2, 1), 2, 1, 0, 0xffffff, 0, {
        full: true,
        dirtyRows: [],
      }),
    ).toMatchObject({ traceId: traceB });
  });

  it("isolates a diagnostic observer failure from terminal protocol truth", () => {
    const remove = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: () => {
        throw new Error("diagnostic failure");
      },
    });
    const ack = vi.fn();
    const nack = vi.fn();
    const replica = new SemanticPaneReplica({
      negotiated: negotiated(),
      workspaceName: "workspace.alpha",
      semanticPaneId: pane,
      ack,
      nack,
    });
    const delivery = seedMessages(blankTerminalReplicaSnapshot(2, 1), "302");
    replica.accept(delivery.envelope);
    for (const chunk of delivery.chunks) replica.accept(chunk);
    expect(ack).toHaveBeenCalledOnce();
    expect(nack).not.toHaveBeenCalled();
    expect(replica.snapshot).not.toBeNull();
    remove();
  });

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
    expect(replica.canonicalSnapshot()).toMatchObject({
      workspaceId: "workspace.alpha",
      workspaceGeneration: generation,
      paneId: pane,
      paneGeneration: `${pane}:${delivery.envelope.incarnation}`,
    });
    expect(replica.canonicalSnapshot()?.snapshot).toBe(replica.snapshot);
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
