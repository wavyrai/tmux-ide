import { describe, expect, it } from "bun:test";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalReplicaDeliveryMetadata,
} from "@tmux-ide/contracts";
import {
  createTerminalFastLane,
  type TerminalFastLaneSourcePort,
} from "@tmux-ide/daemon-client/terminal-fast-lane";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "@tmux-ide/core";

import { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";

const generation = "11111111-1111-4111-8111-111111111111";
const workspaceName = "workspace.test";

class Source implements TerminalFastLaneSourcePort {
  readonly listeners = new Map<
    string,
    (
      update: CanonicalTerminalReplicaUpdate,
      metadata?: TerminalReplicaDeliveryMetadata,
    ) => void
  >();

  subscribe(
    address: { readonly semanticPaneId: string },
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      metadata?: TerminalReplicaDeliveryMetadata,
    ) => void,
  ): () => void {
    this.listeners.set(address.semanticPaneId, listener);
    return () => this.listeners.delete(address.semanticPaneId);
  }

  emit(
    paneId: string,
    update: CanonicalTerminalReplicaUpdate,
    metadata?: TerminalReplicaDeliveryMetadata,
  ): void {
    this.listeners.get(paneId)?.(update, metadata);
  }
}

function seed(
  paneId: string,
  text: string,
  nextGeneration = generation,
): CanonicalTerminalReplicaUpdate {
  const blank = blankTerminalReplicaSnapshot(4, 2);
  const first = blank.grid[0]!;
  const snapshot = {
    ...blank,
    grid: [
      {
        ...first,
        cells: [
          { ...first.cells[0]!, grapheme: text, width: 1 },
          ...first.cells.slice(1),
        ],
      },
      blank.grid[1]!,
    ],
  };
  return {
    type: "terminal.seed",
    workspaceName,
    semanticPaneId: paneId,
    generation: nextGeneration,
    incarnation: `${nextGeneration}:0`,
    revision: 0,
    cols: snapshot.cols,
    rows: snapshot.rows,
    hashAlgorithm: "fnv1a64-v1",
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    snapshot,
  };
}

function paint(adapter: TerminalFastLaneRendererAdapter, paneId: string) {
  const cells = 8;
  return adapter.renderSource.blitPane(
    paneId,
    {
      char: new Uint32Array(cells),
      fg: new Uint16Array(cells * 4),
      bg: new Uint16Array(cells * 4),
      attributes: new Uint32Array(cells),
    },
    4,
    2,
    0,
    0xffffff,
    0,
    { full: true, dirtyRows: [] },
  );
}

describe("TerminalFastLaneRendererAdapter", () => {
  it("invalidates only the addressed pane and retains no second replica reducer", () => {
    const source = new Source();
    const lane = createTerminalFastLane({
      address: { workspaceName, generation },
      source,
      repair: { request: () => undefined },
      control: {
        owns: () => true,
        request: async () => true,
        write: async () => "ok",
        resize: async () => "ok",
      },
    });
    const adapter = new TerminalFastLaneRendererAdapter(lane, 7);
    const editor: Array<[number, number]> = [];
    const tests: Array<[number, number]> = [];
    const stopEditor = adapter.subscribePaneVersion("pane.editor", (version, epoch) =>
      editor.push([version, epoch]),
    );
    const stopTests = adapter.subscribePaneVersion("pane.tests", (version, epoch) =>
      tests.push([version, epoch]),
    );

    expect(adapter.hasCanonicalSnapshot()).toBe(false);
    source.emit("pane.editor", seed("pane.editor", "E"));

    expect(adapter.hasCanonicalSnapshot()).toBe(true);
    expect(editor).toEqual([[1, 7]]);
    expect(tests).toEqual([]);
    expect(adapter.paneVersion("pane.editor")).toBe(1);
    expect(adapter.paneVersion("pane.tests")).toBe(0);
    expect(adapter.renderSource.cursorState("pane.editor")).toMatchObject({ x: 0, y: 0 });
    expect(adapter.renderSource.scrollbackDepth("pane.editor")).toBe(0);

    stopEditor();
    stopTests();
    adapter.dispose();
    lane.dispose();
    expect(source.listeners.size).toBe(0);
  });

  it("observer failures do not prevent sibling observers", () => {
    const source = new Source();
    const lane = createTerminalFastLane({
      address: { workspaceName, generation },
      source,
      repair: { request: () => undefined },
      control: {
        owns: () => true,
        request: async () => true,
        write: async () => "ok",
        resize: async () => "ok",
      },
    });
    const adapter = new TerminalFastLaneRendererAdapter(lane);
    const seen: number[] = [];
    adapter.subscribePaneVersion("pane.editor", () => {
      throw new Error("observer failed");
    });
    adapter.subscribePaneVersion("pane.editor", (version) => seen.push(version));

    source.emit("pane.editor", seed("pane.editor", "E"));

    expect(seen).toEqual([1]);
    adapter.dispose();
    lane.dispose();
  });

  it("returns a delivery trace exactly once and clears stale traces on generation replacement", () => {
    const source = new Source();
    const lane = createTerminalFastLane({
      address: { workspaceName, generation },
      source,
      repair: { request: () => undefined },
      control: {
        owns: () => true,
        request: async () => true,
        write: async () => "ok",
        resize: async () => "ok",
      },
    });
    const adapter = new TerminalFastLaneRendererAdapter(lane);
    adapter.subscribePaneVersion("pane.editor", () => undefined);
    adapter.subscribePaneVersion("pane.tests", () => undefined);
    const traceId = "22222222-2222-4222-8222-222222222222";

    source.emit("pane.editor", seed("pane.editor", "E"), { performanceTraceId: traceId });

    expect(paint(adapter, "pane.editor")).toEqual({
      traceId,
      generation,
      incarnation: `${generation}:0`,
    });
    expect(paint(adapter, "pane.editor")).toBeNull();
    expect(paint(adapter, "pane.tests")).toBeNull();

    source.emit("pane.editor", seed("pane.editor", "U"), { performanceTraceId: traceId });
    const nextGeneration = "33333333-3333-4333-8333-333333333333";
    lane.replaceGeneration(nextGeneration);
    source.emit("pane.editor", seed("pane.editor", "N", nextGeneration));
    expect(paint(adapter, "pane.editor")).toBeNull();

    adapter.dispose();
    lane.dispose();
  });
});
