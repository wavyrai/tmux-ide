import { describe, expect, it, spyOn } from "bun:test";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalReplicaDeliveryMetadata,
} from "@tmux-ide/contracts";
import {
  createTerminalFastLane,
  type TerminalFastLaneSourcePort,
} from "@tmux-ide/daemon-client/terminal-fast-lane";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";

import { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";
import { installTuiPerformanceEventSink } from "../performance-events.ts";

const generation = "11111111-1111-4111-8111-111111111111";
const workspaceName = "workspace.test";

class Source implements TerminalFastLaneSourcePort {
  readonly listeners = new Map<
    string,
    (update: CanonicalTerminalReplicaUpdate, metadata?: TerminalReplicaDeliveryMetadata) => void
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
        cells: [{ ...first.cells[0]!, grapheme: text, width: 1 }, ...first.cells.slice(1)],
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
  return paintViewport(adapter, paneId, 4, 2);
}

function paintViewport(
  adapter: TerminalFastLaneRendererAdapter,
  paneId: string,
  width: number,
  height: number,
) {
  const cells = width * height;
  const trace = adapter.renderSource.blitPane(
    paneId,
    {
      char: new Uint32Array(cells),
      fg: new Uint16Array(cells * 4),
      bg: new Uint16Array(cells * 4),
      attributes: new Uint32Array(cells),
    },
    width,
    height,
    0,
    0xffffff,
    0,
    { full: true, dirtyRows: [] },
  );
  adapter.renderSource.acknowledgePresentation?.(paneId, width, height);
  return trace;
}

describe("TerminalFastLaneRendererAdapter", () => {
  it("projects the exact retained canonical identity through the production render source", () => {
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
    const unsubscribe = adapter.subscribePaneVersion("pane.editor", () => undefined);
    try {
      const update = seed("pane.editor", "S");
      source.emit("pane.editor", update);
      expect(adapter.renderSource.paneCanonicalIdentity?.("pane.editor")).toEqual({
        generation: update.generation,
        incarnation: update.incarnation,
        revision: update.revision,
        stateHash: update.stateHash,
        cols: update.cols,
        rows: update.rows,
        sourceEpoch: 7,
        historyTrim: 0,
      });
      expect(adapter.renderSource.paneCanonicalIdentity?.("pane.missing")).toBeNull();
    } finally {
      unsubscribe();
      adapter.dispose();
      lane.dispose();
    }
  });

  it("keeps dirty-row invalidation and paint live when the trace sink throws", () => {
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
    let version = 0;
    const unsubscribe = adapter.subscribePaneVersion("pane.editor", (next) => (version = next));
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalTraceStage: () => {
        throw new Error("trace sink failed");
      },
    });
    const traceId = "11111111-1111-4111-8111-111111111111";
    try {
      expect(() =>
        source.emit("pane.editor", seed("pane.editor", "S"), {
          performanceTraceId: traceId,
        }),
      ).not.toThrow();
      expect(version).toBe(1);
      expect(paint(adapter, "pane.editor")).toMatchObject({ traceId });
      expect(adapter.hasPaintedCanonicalSnapshot()).toBe(true);
    } finally {
      uninstall();
      unsubscribe();
      adapter.dispose();
      lane.dispose();
    }
  });

  it("keeps canonical paint live when the causal diagnostic ledger throws", () => {
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
    const adapter = new TerminalFastLaneRendererAdapter(lane, 1, {
      noteDelivery: () => undefined,
      notePaint: () => {
        throw new Error("diagnostic paint");
      },
    } as never);
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalPaint: () => undefined,
    });
    const unsubscribe = adapter.subscribePaneVersion("pane.editor", () => undefined);
    try {
      source.emit("pane.editor", seed("pane.editor", "S"));
      expect(() => paint(adapter, "pane.editor")).not.toThrow();
      expect(adapter.hasPaintedCanonicalSnapshot()).toBe(true);
    } finally {
      uninstall();
      unsubscribe();
      adapter.dispose();
      lane.dispose();
    }
  });

  it("publishes only pending canonical presentations and ignores local repaint acknowledgements", () => {
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
    const install = () =>
      installTuiPerformanceEventSink({
        frame: () => undefined,
        terminalPaint: () => undefined,
        terminalDelivery: () => undefined,
        terminalCanonicalHostFrame: () => undefined,
        terminalFrameFence: () => undefined,
      });
    let unsubscribe = adapter.subscribePaneVersion("pane.editor", () => undefined);
    try {
      const uninstall = install();
      const first = seed("pane.editor", "S");
      source.emit("pane.editor", first);
      paint(adapter, "pane.editor");
      expect(adapter.hasPendingCanonicalHostFrameDiagnostics()).toBe(true);
      expect(adapter.drainCanonicalHostFrameIdentities().identities).toHaveLength(1);
      expect(adapter.hasPendingCanonicalHostFrameDiagnostics()).toBe(false);
      unsubscribe();
      unsubscribe = adapter.subscribePaneVersion("pane.editor", () => undefined);
      paintViewport(adapter, "pane.editor", 3, 2);
      expect(adapter.drainCanonicalHostFrameIdentities()).toEqual({ identities: [], dropped: 0 });
      unsubscribe();
      unsubscribe = adapter.subscribePaneVersion("pane.editor", () => undefined);
      paint(adapter, "pane.editor");
      expect(adapter.drainCanonicalHostFrameIdentities()).toEqual({ identities: [], dropped: 0 });
      let unsubscribeSecond = adapter.subscribePaneVersion("pane.second", () => undefined);
      const second = seed("pane.second", "T");
      source.emit("pane.second", second);
      paint(adapter, "pane.second");
      expect(adapter.drainCanonicalHostFrameIdentities().identities).toHaveLength(1);
      unsubscribeSecond();
      unsubscribeSecond = adapter.subscribePaneVersion("pane.second", () => undefined);
      paintViewport(adapter, "pane.second", 3, 2);
      expect(adapter.drainCanonicalHostFrameIdentities()).toEqual({ identities: [], dropped: 0 });
      unsubscribeSecond();
      uninstall();
      source.emit("pane.editor", {
        ...first,
        type: "terminal.patch",
        baseRevision: 0,
        revision: 1,
        patch: { rows: [], modes: first.snapshot.modes },
      });
      paint(adapter, "pane.editor");
      expect(adapter.drainCanonicalHostFrameIdentities()).toEqual({ identities: [], dropped: 0 });
    } finally {
      unsubscribe();
      adapter.dispose();
      lane.dispose();
    }
  });

  it("bounds exact seen identities at 256 and reports then resets the 257th drop", () => {
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
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalHostFrame: () => undefined,
      terminalFrameFence: () => undefined,
    });
    const first = seed("pane.editor", "S");
    let unsubscribe = adapter.subscribePaneVersion("pane.editor", () => undefined);
    try {
      source.emit("pane.editor", first);
      let snapshot = first.snapshot;
      for (let ordinal = 0; ordinal < 257; ordinal += 1) {
        if (ordinal > 0) {
          const next = {
            ...snapshot,
            cursor: { ...snapshot.cursor, hidden: !snapshot.cursor.hidden },
          };
          source.emit("pane.editor", {
            ...first,
            type: "terminal.patch",
            baseRevision: ordinal - 1,
            revision: ordinal,
            stateHash: hashTerminalReplicaSnapshot(next),
            patch: { rows: [], cursor: next.cursor },
          });
          snapshot = next;
        }
        paintViewport(adapter, "pane.editor", ordinal + 1, 2);
        const drained = adapter.drainCanonicalHostFrameIdentities();
        if (ordinal < 256) {
          expect(drained.identities).toHaveLength(1);
          expect(drained.dropped).toBe(0);
        } else {
          expect(drained).toEqual({ identities: [], dropped: 1 });
        }
      }
      expect(adapter.drainCanonicalHostFrameIdentities()).toEqual({ identities: [], dropped: 0 });
    } finally {
      unsubscribe();
      adapter.dispose();
      lane.dispose();
      uninstall();
    }
  });

  it("does not queue host identities for either partial sink configuration", () => {
    for (const partialSink of [
      { terminalCanonicalHostFrame: () => undefined },
      { terminalFrameFence: () => undefined },
    ]) {
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
      const uninstall = installTuiPerformanceEventSink({
        frame: () => undefined,
        terminalPaint: () => undefined,
        terminalDelivery: () => undefined,
        ...partialSink,
      });
      const unsubscribe = adapter.subscribePaneVersion("pane.editor", () => undefined);
      try {
        source.emit("pane.editor", seed("pane.editor", "S"));
        paint(adapter, "pane.editor");
        expect(adapter.drainCanonicalHostFrameIdentities()).toEqual({
          identities: [],
          dropped: 0,
        });
      } finally {
        unsubscribe();
        adapter.dispose();
        lane.dispose();
        uninstall();
      }
    }
  });

  it("qualifies a retained seed accepted before the renderer mounts", () => {
    const publications: Array<Record<string, unknown>> = [];
    const paints: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const modes: Array<Record<string, unknown>> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalPublication: (event) => publications.push(event),
      terminalCanonicalPaint: (event) => paints.push(event),
      terminalCanonicalUpdate: (event) => updates.push(event),
      terminalCanonicalMode: (event) => modes.push(event),
      terminalCanonicalHostFrame: () => undefined,
      terminalFrameFence: () => undefined,
    });
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
    lane.retainPanes(["pane.editor"]);
    const original = seed("pane.editor", "S");
    const snapshot = {
      ...original.snapshot,
      modes: {
        ...original.snapshot.modes,
        mouseProtocol: "drag" as const,
        mouseEncoding: "sgr" as const,
      },
    };
    const first = {
      ...original,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      snapshot,
    };
    source.emit("pane.editor", first);
    const adapter = new TerminalFastLaneRendererAdapter(lane, 7);
    try {
      adapter.subscribePaneVersion("pane.editor", () => undefined);
      paint(adapter, "pane.editor");
      expect(publications).toHaveLength(1);
      expect(paints).toHaveLength(1);
      expect(updates).toHaveLength(0);
      expect(modes).toEqual([
        expect.objectContaining({
          semanticPaneId: "pane.editor",
          revision: first.revision,
          mouseProtocol: "drag",
          mouseEncoding: "sgr",
        }),
      ]);
      adapter.subscribePaneVersion("pane.editor", () => undefined)();
      expect(modes).toHaveLength(1);
      expect(paints[0]).toMatchObject({
        semanticPaneId: "pane.editor",
        revision: first.revision,
        stateHash: first.stateHash,
      });
      expect(adapter.drainCanonicalHostFrameIdentities().identities).toEqual([
        expect.objectContaining({
          acceptedUpdateType: "terminal.seed",
          acceptedRevision: first.revision,
        }),
      ]);
    } finally {
      adapter.dispose();
      lane.dispose();
      uninstall();
    }
  });

  it("does not qualify a retained seed after a patch accepted before renderer mount", () => {
    const publications: Array<Record<string, unknown>> = [];
    const paints: Array<Record<string, unknown>> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalPublication: (event) => publications.push(event),
      terminalCanonicalPaint: (event) => paints.push(event),
      terminalCanonicalHostFrame: () => undefined,
      terminalFrameFence: () => undefined,
    });
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
    lane.retainPanes(["pane.editor"]);
    const first = seed("pane.editor", "S");
    source.emit("pane.editor", first);
    source.emit("pane.editor", {
      ...first,
      type: "terminal.patch",
      baseRevision: 0,
      revision: 1,
      patch: { rows: [], modes: first.snapshot.modes },
    });
    const adapter = new TerminalFastLaneRendererAdapter(lane, 7);
    try {
      adapter.subscribePaneVersion("pane.editor", () => undefined);
      paint(adapter, "pane.editor");
      expect(publications).toHaveLength(0);
      expect(paints).toHaveLength(0);
      expect(adapter.drainCanonicalHostFrameIdentities().identities).toEqual([
        expect.objectContaining({ acceptedUpdateType: "terminal.patch", acceptedRevision: 1 }),
      ]);
    } finally {
      adapter.dispose();
      lane.dispose();
      uninstall();
    }
  });

  it("emits one exact seed-to-first-paint identity and clears it on an intervening patch", () => {
    const publications: Array<Record<string, unknown>> = [];
    const paints: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalPublication: (event) => publications.push(event),
      terminalCanonicalPaint: (event) => paints.push(event),
      terminalCanonicalUpdate: (event) => updates.push(event),
    });
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
    adapter.subscribePaneVersion("pane.editor", () => undefined);
    try {
      const first = seed("pane.editor", "S");
      source.emit("pane.editor", first);
      paint(adapter, "pane.editor");
      expect(publications).toHaveLength(1);
      expect(paints).toHaveLength(1);
      expect(paints[0]).toMatchObject({
        semanticPaneId: "pane.editor",
        generation,
        incarnation: first.incarnation,
        revision: first.revision,
        stateHash: first.stateHash,
        cols: 4,
        rows: 2,
        viewportCols: 4,
        viewportRows: 2,
        writtenRows: [0, 1],
        sourceEpoch: 7,
      });
      source.emit("pane.editor", {
        ...first,
        type: "terminal.patch",
        baseRevision: 0,
        revision: 1,
        patch: { rows: [], modes: first.snapshot.modes },
      });
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        updateType: "terminal.patch",
        semanticPaneId: "pane.editor",
        generation,
        revision: 1,
        sourceEpoch: 7,
      });

      adapter.subscribePaneVersion("pane.second", () => undefined);
      const second = seed("pane.second", "T");
      source.emit("pane.second", second);
      source.emit("pane.second", {
        ...second,
        type: "terminal.patch",
        baseRevision: 0,
        revision: 1,
        patch: { rows: [], modes: second.snapshot.modes },
      });
      paint(adapter, "pane.second");
      expect(publications).toHaveLength(2);
      expect(paints).toHaveLength(1);
    } finally {
      adapter.dispose();
      uninstall();
    }
  });

  it("reports exact canonical wraparound transitions only through the optional diagnostic sink", () => {
    const events: Array<{
      wraparound: boolean;
      mouseProtocol: string;
      mouseEncoding: string;
      revision: number;
      stateHash: string;
    }> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalMode: ({ wraparound, mouseProtocol, mouseEncoding, revision, stateHash }) =>
        events.push({ wraparound, mouseProtocol, mouseEncoding, revision, stateHash }),
    });
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
    try {
      const initial = seed("pane.editor", "E");
      source.emit("pane.editor", initial);
      let snapshot = {
        ...initial.snapshot,
        modes: { ...initial.snapshot.modes, wraparound: false },
      };
      source.emit("pane.editor", {
        ...initial,
        type: "terminal.patch",
        baseRevision: 0,
        revision: 1,
        stateHash: hashTerminalReplicaSnapshot(snapshot),
        patch: { rows: [], modes: snapshot.modes },
      });
      snapshot = { ...snapshot, modes: { ...snapshot.modes, wraparound: true } };
      source.emit("pane.editor", {
        ...initial,
        type: "terminal.patch",
        baseRevision: 1,
        revision: 2,
        stateHash: hashTerminalReplicaSnapshot(snapshot),
        patch: { rows: [], modes: snapshot.modes },
      });
      const wrapSnapshot = snapshot;
      snapshot = {
        ...snapshot,
        modes: {
          ...snapshot.modes,
          mouseTracking: true,
          mouseProtocol: "drag",
          mouseEncoding: "sgr",
        },
      };
      source.emit("pane.editor", {
        ...initial,
        type: "terminal.patch",
        baseRevision: 2,
        revision: 3,
        stateHash: hashTerminalReplicaSnapshot(snapshot),
        patch: { rows: [], modes: snapshot.modes },
      });
      expect(events).toEqual([
        {
          wraparound: true,
          mouseProtocol: "none",
          mouseEncoding: "default",
          revision: 0,
          stateHash: initial.stateHash,
        },
        {
          wraparound: false,
          mouseProtocol: "none",
          mouseEncoding: "default",
          revision: 1,
          stateHash: hashTerminalReplicaSnapshot({
            ...initial.snapshot,
            modes: { ...initial.snapshot.modes, wraparound: false },
          }),
        },
        {
          wraparound: true,
          mouseProtocol: "none",
          mouseEncoding: "default",
          revision: 2,
          stateHash: hashTerminalReplicaSnapshot(wrapSnapshot),
        },
        {
          wraparound: true,
          mouseProtocol: "drag",
          mouseEncoding: "sgr",
          revision: 3,
          stateHash: hashTerminalReplicaSnapshot(snapshot),
        },
      ]);
    } finally {
      adapter.dispose();
      lane.dispose();
      uninstall();
    }
  });

  it("reports every full reseed mode once while unchanged patches stay silent", () => {
    const modes: Array<{ revision: number; stateHash: string }> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalMode: ({ revision, stateHash }) => modes.push({ revision, stateHash }),
    });
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
    try {
      const firstBlank = blankTerminalReplicaSnapshot(160, 42);
      const first = {
        ...seed("pane.editor", "E"),
        cols: firstBlank.cols,
        rows: firstBlank.rows,
        stateHash: hashTerminalReplicaSnapshot(firstBlank),
        snapshot: firstBlank,
      };
      source.emit("pane.editor", first);
      const resizedBlank = blankTerminalReplicaSnapshot(132, 41);
      const snapshot = {
        ...resizedBlank,
        cursor: first.snapshot.cursor,
        modes: first.snapshot.modes,
      };
      const second = {
        ...first,
        revision: 1,
        cols: snapshot.cols,
        rows: snapshot.rows,
        stateHash: hashTerminalReplicaSnapshot(snapshot),
        snapshot,
      };
      source.emit("pane.editor", second);
      source.emit("pane.editor", second);
      source.emit("pane.editor", {
        ...second,
        type: "terminal.patch",
        baseRevision: 1,
        revision: 2,
        patch: { rows: [] },
      });
      expect(modes).toEqual([
        { revision: first.revision, stateHash: first.stateHash },
        { revision: second.revision, stateHash: second.stateHash },
      ]);
    } finally {
      adapter.dispose();
      lane.dispose();
      uninstall();
    }
  });

  it("keeps accepted reseeds live when mode diagnostics are absent or throw", () => {
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
    const first = seed("pane.editor", "E");
    try {
      source.emit("pane.editor", first);
      const secondSnapshot = blankTerminalReplicaSnapshot(5, 3);
      const second = {
        ...first,
        revision: 1,
        cols: secondSnapshot.cols,
        rows: secondSnapshot.rows,
        stateHash: hashTerminalReplicaSnapshot(secondSnapshot),
        snapshot: secondSnapshot,
      };
      const now = spyOn(performance, "now");
      source.emit("pane.editor", second);
      expect(now).not.toHaveBeenCalled();
      now.mockRestore();
      expect(adapter.paneCanonicalIdentity("pane.editor")?.revision).toBe(1);

      const uninstall = installTuiPerformanceEventSink({
        frame: () => undefined,
        terminalPaint: () => undefined,
        terminalDelivery: () => undefined,
        terminalCanonicalMode: () => {
          throw new Error("diagnostic failed");
        },
      });
      try {
        const thirdSnapshot = blankTerminalReplicaSnapshot(6, 4);
        expect(() =>
          source.emit("pane.editor", {
            ...second,
            revision: 2,
            cols: thirdSnapshot.cols,
            rows: thirdSnapshot.rows,
            stateHash: hashTerminalReplicaSnapshot(thirdSnapshot),
            snapshot: thirdSnapshot,
          }),
        ).not.toThrow();
        expect(adapter.paneCanonicalIdentity("pane.editor")?.revision).toBe(2);
      } finally {
        uninstall();
      }
    } finally {
      adapter.dispose();
      lane.dispose();
    }
  });

  it("publishes cursor-only canonical changes through the presentation lane without dirty rows", () => {
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
    const notifications: Array<readonly [number, number, string]> = [];
    adapter.subscribePaneVersion(
      "pane.editor",
      (version, _sourceEpoch, presentationVersion, kind) =>
        notifications.push([version, presentationVersion, kind]),
    );
    try {
      const initial = seed("pane.editor", "E");
      source.emit("pane.editor", initial);
      paint(adapter, "pane.editor");
      notifications.length = 0;
      const snapshot = {
        ...initial.snapshot,
        cursor: { ...initial.snapshot.cursor, x: 2, style: "bar" as const, blink: true },
      };
      source.emit(
        "pane.editor",
        {
          ...initial,
          type: "terminal.patch",
          baseRevision: 0,
          revision: 1,
          stateHash: hashTerminalReplicaSnapshot(snapshot),
          patch: { rows: [], cursor: snapshot.cursor },
        },
        { performanceTraceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      );
      expect(notifications).toEqual([[1, 1, "presentation"]]);
      expect(adapter.paneVersion("pane.editor")).toBe(1);
      expect(adapter.panePresentationVersion("pane.editor")).toBe(1);
      expect(adapter.renderSource.cursorState("pane.editor")).toEqual(snapshot.cursor);
      expect(adapter.renderSource.cursorPresentationTrace?.("pane.editor")).toMatchObject({
        traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revision: 1,
      });
    } finally {
      adapter.dispose();
      lane.dispose();
    }
  });

  it("fences a coalesced cursor acknowledgment to the latest exact canonical revision", () => {
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalHostFrame: () => undefined,
      terminalFrameFence: () => undefined,
    });
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
    try {
      const initial = seed("pane.editor", "E");
      source.emit("pane.editor", initial);
      paint(adapter, "pane.editor");
      adapter.drainCanonicalHostFrameIdentities();
      const firstSnapshot = {
        ...initial.snapshot,
        cursor: { ...initial.snapshot.cursor, x: 1 },
      };
      source.emit("pane.editor", {
        ...initial,
        type: "terminal.patch",
        baseRevision: 0,
        revision: 1,
        stateHash: hashTerminalReplicaSnapshot(firstSnapshot),
        patch: { rows: [], cursor: firstSnapshot.cursor },
      });
      const secondSnapshot = {
        ...firstSnapshot,
        cursor: { ...firstSnapshot.cursor, x: 2 },
      };
      source.emit("pane.editor", {
        ...initial,
        type: "terminal.patch",
        baseRevision: 1,
        revision: 2,
        stateHash: hashTerminalReplicaSnapshot(secondSnapshot),
        patch: { rows: [], cursor: secondSnapshot.cursor },
      });
      adapter.renderSource.acknowledgePresentation?.("pane.editor", 4, 2);
      expect(adapter.drainCanonicalHostFrameIdentities().identities).toMatchObject([
        { revision: 2, stateHash: hashTerminalReplicaSnapshot(secondSnapshot) },
      ]);
      adapter.renderSource.acknowledgePresentation?.("pane.editor", 4, 2);
      expect(adapter.drainCanonicalHostFrameIdentities()).toEqual({ identities: [], dropped: 0 });
    } finally {
      adapter.dispose();
      lane.dispose();
      uninstall();
    }
  });

  it("does no patch diagnostic clock work when disabled and keeps throwing observers fail-open", () => {
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
    const adapter = new TerminalFastLaneRendererAdapter(lane, 9);
    adapter.subscribePaneVersion("pane.editor", () => undefined);
    const first = seed("pane.editor", "E");
    source.emit("pane.editor", first);
    paint(adapter, "pane.editor");
    const now = spyOn(performance, "now");
    const patch = {
      ...first,
      type: "terminal.patch" as const,
      baseRevision: 0,
      revision: 1,
      patch: { rows: [], modes: first.snapshot.modes },
    };
    try {
      source.emit("pane.editor", patch);
      expect(now).not.toHaveBeenCalled();
      const uninstall = installTuiPerformanceEventSink({
        frame: () => undefined,
        terminalPaint: () => undefined,
        terminalDelivery: () => undefined,
        terminalCanonicalUpdate: () => {
          throw new Error("diagnostic failed");
        },
      });
      try {
        expect(() =>
          source.emit("pane.editor", { ...patch, baseRevision: 1, revision: 2 }),
        ).not.toThrow();
      } finally {
        uninstall();
      }
    } finally {
      now.mockRestore();
      adapter.dispose();
      lane.dispose();
    }
  });
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
    expect(adapter.hasPaintedCanonicalSnapshot()).toBe(false);
    expect(editor).toEqual([[1, 7]]);
    expect(tests).toEqual([]);
    expect(adapter.paneVersion("pane.editor")).toBe(1);
    expect(adapter.paneVersion("pane.tests")).toBe(0);
    expect(adapter.renderSource.cursorState("pane.editor")).toMatchObject({ x: 0, y: 0 });
    expect(adapter.renderSource.scrollbackDepth("pane.editor")).toBe(0);
    paint(adapter, "pane.editor");
    expect(adapter.hasPaintedCanonicalSnapshot()).toBe(true);

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
    const initial = seed("pane.editor", "E");

    source.emit("pane.editor", initial, { performanceTraceId: traceId });

    expect(paint(adapter, "pane.editor")).toEqual({
      traceId,
      generation,
      incarnation: `${generation}:0`,
      semanticPaneId: "pane.editor",
      revision: 0,
      stateHash: initial.stateHash,
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

  it("never consumes a trace from duplicate, reordered, stale, or unchanged output", () => {
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
    const traceId = "44444444-4444-4444-8444-444444444444";
    const initial = seed("pane.editor", "E");
    source.emit("pane.editor", initial);
    paint(adapter, "pane.editor");

    // Identical and stale seeds are reducer no-ops; metadata cannot smuggle a
    // trace through to a later unrelated framebuffer walk.
    source.emit("pane.editor", initial, { performanceTraceId: traceId });
    source.emit(
      "pane.editor",
      {
        type: "terminal.patch",
        workspaceName,
        semanticPaneId: "pane.editor",
        generation,
        incarnation: `${generation}:0`,
        baseRevision: 2,
        revision: 3,
        cols: 4,
        rows: 2,
        hashAlgorithm: "fnv1a64-v1",
        stateHash: initial.stateHash,
        patch: { rows: [] },
      },
      { performanceTraceId: traceId },
    );
    expect(paint(adapter, "pane.editor")).toBeNull();

    // A valid patch whose cells are byte-for-byte unchanged advances canonical
    // revision but still is not a changed-cell paint sample.
    source.emit(
      "pane.editor",
      {
        type: "terminal.patch",
        workspaceName,
        semanticPaneId: "pane.editor",
        generation,
        incarnation: `${generation}:0`,
        baseRevision: 0,
        revision: 1,
        cols: 4,
        rows: 2,
        hashAlgorithm: "fnv1a64-v1",
        stateHash: initial.stateHash,
        patch: { rows: [] },
      },
      { performanceTraceId: traceId },
    );
    expect(paint(adapter, "pane.editor")).toBeNull();

    adapter.dispose();
    lane.dispose();
  });

  it("retains the earliest changed-cell trace across coalesced and no-op publications", () => {
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
    const earliest = "55555555-5555-4555-8555-555555555555";
    const later = "66666666-6666-4666-8666-666666666666";
    const initial = seed("pane.editor", "E");
    source.emit("pane.editor", initial, { performanceTraceId: earliest });

    // A coalesced later changed seed must not bias latency downward by
    // replacing the leading trace that has already waited for this paint.
    source.emit(
      "pane.editor",
      { ...seed("pane.editor", "U"), revision: 1 },
      { performanceTraceId: later },
    );
    // An untraced no-op publication before render cannot erase the owner.
    source.emit("pane.editor", {
      type: "terminal.patch",
      workspaceName,
      semanticPaneId: "pane.editor",
      generation,
      incarnation: `${generation}:0`,
      baseRevision: 1,
      revision: 2,
      cols: 4,
      rows: 2,
      hashAlgorithm: "fnv1a64-v1",
      stateHash: seed("pane.editor", "U").stateHash,
      patch: { rows: [] },
    });

    const latest = seed("pane.editor", "U");
    expect(paint(adapter, "pane.editor")).toEqual({
      traceId: earliest,
      generation,
      incarnation: `${generation}:0`,
      semanticPaneId: "pane.editor",
      revision: 2,
      stateHash: latest.stateHash,
    });
    expect(paint(adapter, "pane.editor")).toBeNull();
    adapter.dispose();
    lane.dispose();
  });

  it("repaints retained canonical output after switching away and back", () => {
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
    const firstAdapter = new TerminalFastLaneRendererAdapter(lane);
    const stop = firstAdapter.subscribePaneVersion("pane.editor", () => undefined);
    const initial = seed("pane.editor", "E");
    source.emit("pane.editor", initial);
    paint(firstAdapter, "pane.editor");
    stop();
    firstAdapter.dispose();

    const changedRow = {
      ...initial.snapshot.grid[0]!,
      cells: initial.snapshot.grid[0]!.cells.map((cell, index) =>
        index === 0 ? { ...cell, grapheme: "R" } : cell,
      ),
    };
    const nextSnapshot = {
      ...initial.snapshot,
      grid: [changedRow, initial.snapshot.grid[1]!],
    };
    source.emit("pane.editor", {
      type: "terminal.patch",
      workspaceName,
      semanticPaneId: "pane.editor",
      generation,
      incarnation: `${generation}:0`,
      baseRevision: 0,
      revision: 1,
      cols: 4,
      rows: 2,
      hashAlgorithm: "fnv1a64-v1",
      stateHash: hashTerminalReplicaSnapshot(nextSnapshot),
      patch: { rows: [{ index: 0, row: changedRow }] },
    });

    const remounted = new TerminalFastLaneRendererAdapter(lane, 2);
    const versions: Array<[number, number]> = [];
    remounted.subscribePaneVersion("pane.editor", (version, epoch) =>
      versions.push([version, epoch]),
    );
    const cells = new Uint32Array(8);
    remounted.renderSource.blitPane(
      "pane.editor",
      {
        char: cells,
        fg: new Uint16Array(32),
        bg: new Uint16Array(32),
        attributes: new Uint32Array(8),
      },
      4,
      2,
      0,
      0xffffff,
      0,
      { full: true, dirtyRows: [] },
    );
    expect(versions).toEqual([[1, 2]]);
    expect(String.fromCodePoint(cells[0]!)).toBe("R");
    expect(remounted.hasPaintedCanonicalSnapshot()).toBe(true);

    remounted.dispose();
    lane.dispose();
  });
});
