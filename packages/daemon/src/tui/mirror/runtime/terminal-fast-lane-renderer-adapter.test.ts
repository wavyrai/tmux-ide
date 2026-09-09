import { decodeNativeGridCapture } from "../../../terminal/mirror/native-grid-capture.ts";
import { describe, expect, it, spyOn } from "bun:test";
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
  hashTerminalReplicaTombstone,
} from "@tmux-ide/core";

import * as viewport from "../terminal-viewport.ts";
import { createTerminalScrollback } from "../workspace/terminal-scrollback.ts";
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
  it.each([
    [false, 1],
    [true, 1],
    [false, 2],
    [true, 2],
  ] as const)(
    "fences asynchronous native backing to the retained view (released: %s, version: %s)",
    async (released, version) => {
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
      const backing = decodeNativeGridCapture(
        JSON.stringify({
          version,
          cols: 4,
          rows: 2,
          history: 0,
          hscrolled: 0,
          limit: 100,
          cursor: [0, 0],
        }) +
          "\n" +
          JSON.stringify({
            row: 0,
            flags: 0,
            used: 4,
            cells: [
              [0, 1, "41", 0, 8, 8, 8, 0, 0],
              ...Array.from({ length: 3 }, () => [0, 1, "20", 0, 8, 8, 8, 0, 0]),
            ],
          }) +
          "\n" +
          JSON.stringify({
            row: 1,
            flags: 0,
            used: 4,
            cells: Array.from({ length: 4 }, () => [0, 1, "20", 0, 8, 8, 8, 0, 0]),
          }) +
          "\n",
      )!;
      let finish!: (value: typeof backing) => void;
      let calls = 0;
      let signal: AbortSignal | undefined;
      const pending = new Promise<typeof backing>((resolve) => {
        finish = resolve;
      });
      const adapter = new TerminalFastLaneRendererAdapter(
        lane,
        1,
        null,
        null,
        async (_pane, expected, requestSignal) => {
          calls++;
          signal = requestSignal;
          expect(expected.revision).toBe(0);
          return await pending;
        },
      );
      const peer = new TerminalFastLaneRendererAdapter(lane);
      const stop = adapter.subscribePaneVersion("pane.editor", () => undefined);
      const stopPeer = peer.subscribePaneVersion("pane.editor", () => undefined);
      try {
        source.emit("pane.editor", seed("pane.editor", "A"));
        const release = adapter.retainPaneView("pane.editor")!;
        expect(adapter.paneRetainedBackingStatus("pane.editor")).toBe("pending");
        adapter.setNativePaneGeometries([{ paneId: "pane.editor", cols: 2, rows: 2 }]);
        const update = seed("pane.editor", "B");
        source.emit("pane.editor", { ...update, revision: 1 });
        if (released) release();
        finish(backing);
        await pending;
        await Promise.resolve();
        await Promise.resolve();
        expect(calls).toBe(1);
        expect(signal?.aborted).toBe(released);
        expect(adapter.paneRetainedBackingStatus("pane.editor")).toBe(
          released ? null : version === 2 ? "native" : "compatible",
        );
        const heldSnapshot = adapter.paneSelectionSnapshot("pane.editor")!;
        expect([...heldSnapshot.history, ...heldSnapshot.grid][0]?.cells[0]?.grapheme).toBe(
          released ? "B" : "A",
        );
        expect(peer.paneSelectionSnapshot("pane.editor")?.grid[0]?.cells[0]?.grapheme).toBe("B");
        if (!released) release();
      } finally {
        stop();
        stopPeer();
        adapter.dispose();
        peer.dispose();
        lane.dispose();
      }
    },
  );

  it.each([false, true])(
    "uses native layout for a held view despite parser minimum width (layout first: %s)",
    (layoutFirst) => {
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
      const held = new TerminalFastLaneRendererAdapter(lane);
      const peer = new TerminalFastLaneRendererAdapter(lane);
      const releaseHeld = held.subscribePaneVersion("pane.editor", () => undefined);
      const releasePeer = peer.subscribePaneVersion("pane.editor", () => undefined);
      try {
        const update = seed("pane.editor", "H");
        if (update.type !== "terminal.seed") throw new Error("expected seed");
        const snapshot = {
          ...update.snapshot,
          grid: [
            {
              ...update.snapshot.grid[0]!,
              cells: [..."HOLD"].map((grapheme, index) => ({
                ...update.snapshot.grid[0]!.cells[index]!,
                grapheme,
              })),
            },
            {
              ...update.snapshot.grid[1]!,
              cells: update.snapshot.grid[1]!.cells.map((cell) => ({ ...cell, grapheme: "" })),
            },
          ],
        };
        source.emit("pane.editor", {
          ...update,
          snapshot,
          stateHash: hashTerminalReplicaSnapshot(snapshot),
        });
        const native = [{ paneId: "pane.editor", cols: 1, rows: 2 }];
        if (layoutFirst) held.setNativePaneGeometries(native);
        const release = held.retainPaneView("pane.editor")!;
        if (!layoutFirst) held.setNativePaneGeometries(native);
        const frozen = held.paneSelectionSnapshot("pane.editor")!;
        expect(frozen.cols).toBe(1);
        expect(
          [...frozen.history, ...frozen.grid]
            .flatMap((row) => row.cells.map((cell) => cell.grapheme))
            .join(""),
        ).toBe("HOLD");
        const version = held.paneVersion("pane.editor");
        held.setNativePaneGeometries(native);
        expect(held.paneVersion("pane.editor")).toBe(version);

        const parsed = blankTerminalReplicaSnapshot(2, 2);
        source.emit("pane.editor", {
          ...update,
          revision: 1,
          cols: 2,
          snapshot: parsed,
          stateHash: hashTerminalReplicaSnapshot(parsed),
        });
        expect(held.paneSelectionSnapshot("pane.editor")).toBe(frozen);
        expect(held.paneVersion("pane.editor")).toBe(version);
        expect(peer.paneSelectionSnapshot("pane.editor")!.cols).toBe(2);
        expect(lane.paneState("pane.editor")!.snapshot!.cols).toBe(2);
        expect(held.paneCanonicalIdentity("pane.editor")?.cols).toBe(4);
        expect(held.paneCanonicalIdentity("pane.editor")?.viewCols).toBe(1);

        held.setNativePaneGeometries([{ paneId: "pane.editor", cols: 4, rows: 2 }]);
        const restored = held.paneSelectionSnapshot("pane.editor")!;
        expect(
          [...restored.history, ...restored.grid][0]!.cells.map((cell) => cell.grapheme).join(""),
        ).toBe("HOLD");
        release();
        expect(held.paneSelectionSnapshot("pane.editor")!.cols).toBe(2);
      } finally {
        releaseHeld();
        releasePeer();
        held.dispose();
        peer.dispose();
        lane.dispose();
      }
    },
  );
  it.each([1, 2000])(
    "does not repeat a retained resize at width %i for each live publication",
    (targetWidth) => {
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
      const peer = new TerminalFastLaneRendererAdapter(lane);
      adapter.subscribePaneVersion("pane.editor", () => undefined);
      peer.subscribePaneVersion("pane.editor", () => undefined);
      const initial = seed("pane.editor", "A");
      if (initial.type !== "terminal.seed") throw new Error("expected seed");
      const wide = {
        ...initial.snapshot,
        grid: initial.snapshot.grid.map((row, index) =>
          index
            ? row
            : {
                ...row,
                cells: [
                  { ...row.cells[0]!, grapheme: "界", width: 2 as const },
                  { ...row.cells[1]!, grapheme: "", width: 0 as const },
                  ...row.cells.slice(2),
                ],
              },
        ),
      };
      wide.history = Array.from({ length: 1000 }, () => wide.grid[0]!);
      source.emit("pane.editor", {
        ...initial,
        snapshot: wide,
        stateHash: hashTerminalReplicaSnapshot(wide),
      });
      const release = adapter.retainPaneView("pane.editor")!;
      const retained = adapter.paneSelectionSnapshot("pane.editor");
      const reflow = spyOn(viewport, "reflowRetainedTerminalSnapshot");
      let revision = 0;
      const publish = (cols: number) => {
        const snapshot = blankTerminalReplicaSnapshot(cols, 2);
        source.emit("pane.editor", {
          ...initial,
          revision: ++revision,
          cols,
          snapshot,
          stateHash: hashTerminalReplicaSnapshot(snapshot),
        });
      };
      try {
        for (let i = 0; i < 20; i++) publish(targetWidth);
        expect(reflow).toHaveBeenCalledTimes(1);
        if (targetWidth === 1) expect(adapter.paneSelectionSnapshot("pane.editor")?.cols).toBe(1);
        else expect(adapter.paneSelectionSnapshot("pane.editor")).toBe(retained);
        expect(peer.paneSelectionSnapshot("pane.editor")?.cols).toBe(targetWidth);
        expect(lane.paneState("pane.editor")?.revision).toBe(20);
        publish(2);
        expect(reflow).toHaveBeenCalledTimes(2);
        expect(adapter.paneSelectionSnapshot("pane.editor")?.cols).toBe(2);
        const resized = adapter.paneSelectionSnapshot("pane.editor")!;
        expect(
          [...resized.history, ...resized.grid]
            .flatMap((row) => row.cells)
            .some((cell) => cell.grapheme === "界"),
        ).toBe(true);
        publish(targetWidth);
        expect(reflow).toHaveBeenCalledTimes(3);
        publish(targetWidth);
        expect(reflow).toHaveBeenCalledTimes(3);
        release();
        expect(adapter.paneSelectionSnapshot("pane.editor")?.cols).toBe(targetWidth);
      } finally {
        reflow.mockRestore();
        adapter.dispose();
        peer.dispose();
        lane.dispose();
      }
    },
  );

  it("retains one client view while its peer and canonical delivery stay live", () => {
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
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCanonicalHostFrame: () => undefined,
      terminalFrameFence: () => undefined,
    });
    const held = new TerminalFastLaneRendererAdapter(lane);
    const peer = new TerminalFastLaneRendererAdapter(lane);
    let heldPublications = 0;
    let peerPublications = 0;
    const releaseHeld = held.subscribePaneVersion("pane.editor", () => heldPublications++);
    const releasePeer = peer.subscribePaneVersion("pane.editor", () => peerPublications++);
    try {
      const initial = seed("pane.editor", "A");
      source.emit("pane.editor", initial);
      const release = held.retainPaneView("pane.editor")!;
      const heldVersion = held.paneVersion("pane.editor");
      const heldBeforeOutput = heldPublications;
      const peerBeforeOutput = peerPublications;
      expect(release).toBeFunction();
      expect(held.retainPaneView("pane.editor")).toBeNull();
      const next = seed("pane.editor", "B");
      if (next.type !== "terminal.seed") throw new Error("expected seed");
      source.emit("pane.editor", { ...next, revision: 1 });
      expect(heldPublications).toBe(heldBeforeOutput);
      expect(held.paneVersion("pane.editor")).toBe(heldVersion);
      expect(peerPublications).toBe(peerBeforeOutput + 1);
      expect(held.paneSelectionSnapshot("pane.editor")!.grid[0]!.cells[0]!.grapheme).toBe("A");
      expect(peer.paneSelectionSnapshot("pane.editor")!.grid[0]!.cells[0]!.grapheme).toBe("B");
      expect(lane.paneState("pane.editor")!.revision).toBe(1);
      expect(held.renderSource.paneCanonicalIdentity?.("pane.editor")?.revision).toBe(0);
      const buffers = {
        char: new Uint32Array(8),
        fg: new Uint16Array(32),
        bg: new Uint16Array(32),
        attributes: new Uint32Array(8),
      };
      held.renderSource.blitPane("pane.editor", buffers, 4, 2, 0, 0xffffff, 0, {
        full: true,
        dirtyRows: [],
      });
      expect(buffers.char[0]).toBe("A".codePointAt(0)!);
      held.renderSource.acknowledgePresentation?.("pane.editor", 4, 2);
      expect(held.drainCanonicalHostFrameIdentities().identities).toHaveLength(0);
      release();
      expect(heldPublications).toBe(heldBeforeOutput + 1);
      expect(held.paneSelectionSnapshot("pane.editor")!.grid[0]!.cells[0]!.grapheme).toBe("B");
      held.renderSource.blitPane("pane.editor", buffers, 4, 2, 0, 0xffffff, 0, {
        full: false,
        dirtyRows: [],
      });
      expect(buffers.char[0]).toBe("B".codePointAt(0)!);
      held.renderSource.acknowledgePresentation?.("pane.editor", 4, 2);
      expect(
        held.drainCanonicalHostFrameIdentities().identities.map((value) => value.revision),
      ).toEqual([1]);
      const releaseSecond = held.retainPaneView("pane.editor")!;
      release(); // A stale release cannot cancel a newer retained view.
      const third = seed("pane.editor", "C");
      if (third.type !== "terminal.seed") throw new Error("expected seed");
      source.emit("pane.editor", { ...third, revision: 2 });
      expect(held.paneSelectionSnapshot("pane.editor")!.grid[0]!.cells[0]!.grapheme).toBe("B");
      releaseSecond();
      expect(held.paneSelectionSnapshot("pane.editor")!.grid[0]!.cells[0]!.grapheme).toBe("C");
      const releaseBeforeResize = held.retainPaneView("pane.editor")!;
      const resized = blankTerminalReplicaSnapshot(6, 3);
      source.emit("pane.editor", {
        ...third,
        revision: 3,
        cols: 6,
        rows: 3,
        snapshot: resized,
        stateHash: hashTerminalReplicaSnapshot(resized),
      });
      expect(held.paneSelectionSnapshot("pane.editor")!.cols).toBe(6);
      expect(held.paneSelectionSnapshot("pane.editor")!.grid[0]!.cells[0]!.grapheme).toBe("C");
      expect(held.renderSource.paneCanonicalIdentity?.("pane.editor")).toMatchObject({
        cols: 4,
        rows: 2,
        viewCols: 6,
        viewRows: 3,
        revision: 2,
        stateHash: third.stateHash,
      });
      expect(held.retainPaneView("pane.editor")).toBeNull();
      releaseBeforeResize();
      const releaseBeforeReplacement = held.retainPaneView("pane.editor")!;
      releaseBeforeResize();
      source.emit("pane.editor", {
        ...third,
        revision: 4,
        incarnation: `${generation}:1`,
      });
      expect(held.renderSource.paneCanonicalIdentity?.("pane.editor")?.incarnation).toBe(
        `${generation}:1`,
      );
      releaseBeforeReplacement();
      const releaseBeforeClose = held.retainPaneView("pane.editor")!;
      source.emit("pane.editor", {
        type: "terminal.tombstone",
        workspaceName,
        semanticPaneId: "pane.editor",
        generation,
        incarnation: `${generation}:1`,
        baseRevision: 4,
        revision: 5,
        cols: 4,
        rows: 2,
        stateHash: hashTerminalReplicaTombstone("pane-closed"),
        hashAlgorithm: "fnv1a64-v1",
        tombstone: { reason: "pane-closed" },
      });
      expect(held.paneSelectionSnapshot("pane.editor")).toBeNull();
      releaseBeforeClose();
    } finally {
      uninstall();
      releaseHeld();
      releasePeer();
      held.dispose();
      peer.dispose();
      lane.dispose();
    }
  });

  it.each(["unchanged", "append", "trim", "trim-patch"])(
    "keeps a reader anchored after a capture with %s history follows history trimming",
    (mode) => {
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
      const reading = createTerminalScrollback(adapter);
      const peer = createTerminalScrollback(adapter);
      const oldest = createTerminalScrollback(adapter);
      try {
        const initial = seed("pane.editor", "S");
        if (initial.type !== "terminal.seed") throw new Error("expected seed");
        const row = (text: string) => ({
          ...initial.snapshot.grid[0]!,
          cells: initial.snapshot.grid[0]!.cells.map((cell, index) =>
            index === 0 ? { ...cell, grapheme: text } : cell,
          ),
        });
        const snapshot = { ...initial.snapshot, history: [row("A"), row("B"), row("C"), row("D")] };
        source.emit("pane.editor", {
          ...initial,
          snapshot,
          stateHash: hashTerminalReplicaSnapshot(snapshot),
        });
        const next = { ...snapshot, history: [...snapshot.history.slice(1), row("E")] };
        source.emit("pane.editor", {
          ...initial,
          type: "terminal.patch",
          baseRevision: 0,
          revision: 1,
          patch: { rows: [], historyDelta: { trim: 1, append: [row("E")] } },
          stateHash: hashTerminalReplicaSnapshot(next),
        });
        expect(adapter.renderSource.paneCanonicalIdentity?.("pane.editor")?.historyTrim).toBe(1);
        reading.move("pane.editor", 2);
        peer.move("pane.editor", 1);
        oldest.move("pane.editor", 4);
        expect(reading.origin("pane.editor")).toEqual({ x: 0, y: -2 });
        const captured =
          mode === "append"
            ? { ...next, history: [...next.history, row("F")] }
            : mode.startsWith("trim")
              ? { ...next, history: next.history.slice(2) }
              : next;
        source.emit(
          "pane.editor",
          mode === "trim-patch"
            ? {
                ...initial,
                type: "terminal.patch",
                baseRevision: 1,
                revision: 2,
                patch: { rows: [], history: structuredClone(captured.history) },
                stateHash: hashTerminalReplicaSnapshot(captured),
              }
            : {
                ...initial,
                revision: 2,
                snapshot: structuredClone(captured),
                stateHash: hashTerminalReplicaSnapshot(captured),
              },
        );
        const offset = mode === "append" ? 3 : 2;
        expect(reading.origin("pane.editor")).toEqual({ x: 0, y: -offset });
        expect(reading.offset("pane.editor")).toBe(offset);
        expect(peer.offset("pane.editor")).toBe(offset - 1);
        expect(oldest.offset("pane.editor")).toBe(mode.startsWith("trim") ? 2 : offset + 2);
        reading.live("pane.editor");
        expect(peer.offset("pane.editor")).toBe(offset - 1);
      } finally {
        oldest.dispose();
        peer.dispose();
        reading.dispose();
        unsubscribe();
        adapter.dispose();
        lane.dispose();
      }
    },
  );

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

  it("preserves the last coherent framebuffer when canonical state is temporarily absent", () => {
    const source = new Source();
    const repairs: unknown[] = [];
    const lane = createTerminalFastLane({
      address: { workspaceName, generation },
      source,
      repair: { request: (request) => repairs.push(request) },
      control: {
        owns: () => true,
        request: async () => true,
        write: async () => "ok",
        resize: async () => "ok",
      },
    });
    const adapter = new TerminalFastLaneRendererAdapter(lane);
    const unsubscribe = adapter.subscribePaneVersion("pane.editor", () => undefined);
    const cells = 8;
    const buffers = {
      char: new Uint32Array(cells),
      fg: new Uint16Array(cells * 4),
      bg: new Uint16Array(cells * 4),
      attributes: new Uint32Array(cells),
    };
    try {
      source.emit("pane.editor", seed("pane.editor", "S"));
      adapter.renderSource.blitPane("pane.editor", buffers, 4, 2, 0, 0xffffff, 0, {
        full: true,
        dirtyRows: [],
      });
      expect(buffers.char[0]).toBe("S".codePointAt(0)!);

      source.emit("pane.editor", {
        type: "terminal.tombstone",
        workspaceName,
        semanticPaneId: "pane.editor",
        generation,
        incarnation: `${generation}:0`,
        baseRevision: 0,
        revision: 1,
        cols: 4,
        rows: 2,
        stateHash: hashTerminalReplicaTombstone("pane-closed"),
        hashAlgorithm: "fnv1a64-v1",
        tombstone: { reason: "pane-closed" },
      });
      adapter.renderSource.blitPane("pane.editor", buffers, 4, 2, 0, 0xffffff, 0, {
        full: true,
        dirtyRows: [],
      });

      expect(buffers.char[0]).toBe("S".codePointAt(0)!);
      expect(adapter.requestPaneReseed("pane.editor")).toBe(false);
      expect(repairs).toEqual([]);
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

  it.each([false, true])(
    "routes cursor-only changes without waking a frozen view (retained: %s)",
    (retainView) => {
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
        const release = retainView ? adapter.retainPaneView("pane.editor") : null;
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
        if (retainView) {
          expect(notifications).toEqual([]);
          expect(adapter.paneVersion("pane.editor")).toBe(1);
          expect(adapter.panePresentationVersion("pane.editor")).toBe(0);
          expect(adapter.renderSource.cursorState("pane.editor")).toEqual(initial.snapshot.cursor);
          expect(adapter.renderSource.cursorPresentationTrace?.("pane.editor")).toBeNull();
          expect(lane.paneState("pane.editor")!.revision).toBe(1);
          release!();
          expect(notifications).toEqual([[2, 0, "content"]]);
          expect(adapter.renderSource.cursorState("pane.editor")).toEqual(snapshot.cursor);
          return;
        }
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
    },
  );

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

it("does not repaint unchanged history when a scrolled pane is invalidated", () => {
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
  const stop = adapter.subscribePaneVersion("pane.editor", () => undefined);
  const initial = seed("pane.editor", "S");
  if (initial.type !== "terminal.seed") throw new Error("expected seed");
  const snapshot = {
    ...initial.snapshot,
    history: [initial.snapshot.grid[0]!, initial.snapshot.grid[1]!],
  };
  source.emit("pane.editor", {
    ...initial,
    snapshot,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
  });
  const buffers = {
    char: new Uint32Array(8),
    fg: new Uint16Array(32),
    bg: new Uint16Array(32),
    attributes: new Uint32Array(8),
  };
  const first: number[] = [];
  adapter.renderSource.blitPane("pane.editor", buffers, 4, 2, 2, 0xffffff, 0, {
    full: true,
    dirtyRows: first,
  });
  expect(first).toEqual([0, 1]);
  const unchanged: number[] = [];
  adapter.renderSource.blitPane("pane.editor", buffers, 4, 2, 2, 0xffffff, 0, {
    full: false,
    dirtyRows: unchanged,
  });
  expect(unchanged).toEqual([]);
  const forced: number[] = [];
  adapter.renderSource.blitPane("pane.editor", buffers, 4, 2, 2, 0xffffff, 0, {
    full: false,
    forceRows: [1],
    dirtyRows: forced,
  });
  expect(forced).toEqual([1]);
  stop();
  adapter.dispose();
  lane.dispose();
});

it("reuses bounded history row projections without changing cells, styles or graphemes", async () => {
  const { blitSemanticRow, visibleTerminalRowAt } =
    await import("../semantic-pane-render-source.ts");
  const { createSemanticThemeSnapshot, createTerminalPaletteProjection } =
    await import("../theme.ts");
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
  const renderer = new TerminalFastLaneRendererAdapter(lane);
  const stop = renderer.subscribePaneVersion("pane.editor", () => undefined);
  const blank = blankTerminalReplicaSnapshot(200, 54);
  const makeRow = (row: number) => ({
    ...blank.grid[0]!,
    cells: blank.grid[0]!.cells.map((cell, column) => ({
      ...cell,
      grapheme:
        column === 7
          ? "e\u0301"
          : column === 8
            ? "👩‍💻"
            : column === 9
              ? ""
              : String.fromCharCode(33 + ((row + column) % 80)),
      width: column === 8 ? 2 : column === 9 ? 0 : 1,
      attributes: (row + column) % 4,
      foreground:
        column % 3 === 0 ? { kind: "indexed" as const, index: row % 16 } : cell.foreground,
    })),
  });
  const snapshot = {
    ...blank,
    history: Array.from({ length: 320 }, (_, i) => makeRow(i)),
    grid: blank.grid.map((_, i) => makeRow(i + 320)),
  };
  const initial = seed("pane.editor", "A");
  if (initial.type !== "terminal.seed") throw new Error("seed");
  source.emit("pane.editor", {
    ...initial,
    cols: 200,
    rows: 54,
    snapshot,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
  });
  const buffers = (width: number, height: number) => ({
    char: new Uint32Array(width * height),
    fg: new Uint16Array(width * height * 4),
    bg: new Uint16Array(width * height * 4),
    attributes: new Uint32Array(width * height),
  });
  let actual = buffers(200, 54);
  let width = 200,
    height = 54,
    foreground = 0xffffff,
    background = 0;
  let palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
  let consumerId = {};
  const verify = (offset: number, origin?: { x: number; y: number }, forceRows?: number[]) => {
    const expected = buffers(width, height);
    const graphemes: import("../blit.ts").GraphemeOverride[] = [];
    const expectedGraphemes: import("../blit.ts").GraphemeOverride[] = [];
    const dirtyRows: number[] = [];
    renderer.renderSource.blitPane(
      "pane.editor",
      actual,
      width,
      height,
      offset,
      foreground,
      background,
      {
        full: !forceRows,
        forceRows,
        dirtyRows,
        graphemes,
        palette,
        consumerId,
        viewportOrigin: origin,
      },
    );
    const current = renderer.paneSelectionSnapshot("pane.editor")!;
    for (let row = 0; row < height; row++) {
      const canonical = origin ? origin.y + row : row;
      const sourceRow = origin
        ? canonical < 0
          ? current.history[current.history.length + canonical]
          : current.grid[canonical]
        : visibleTerminalRowAt(current, offset, row);
      blitSemanticRow(
        sourceRow,
        expected,
        row,
        width,
        foreground,
        background,
        expectedGraphemes,
        palette,
        origin?.x ?? 0,
      );
    }
    expect(actual).toEqual(expected);
    expect(graphemes).toEqual(
      forceRows
        ? expectedGraphemes.filter((item) => forceRows.includes(item.y))
        : expectedGraphemes,
    );
    return renderer.rowProjectionDiagnostics("pane.editor")!;
  };
  try {
    const first = verify(100);
    expect(first.convertedRows).toBe(54);
    const second = verify(101);
    expect(second.convertedRows - first.convertedRows).toBe(1);
    expect(second.reusedRows - first.reusedRows).toBe(53);
    const third = verify(106);
    expect(third.convertedRows - second.convertedRows).toBe(5);
    verify(101);
    // Post-paint selection/search highlighting must never contaminate the cache.
    actual.attributes.fill(255, 400, 600);
    verify(101, undefined, [2]);
    for (let offset = 110; offset <= 310; offset += 10) {
      const state = verify(offset);
      expect(state.cachedRows).toBeLessThanOrEqual(108);
      expect(state.cachedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    const beforeJump = renderer.rowProjectionDiagnostics("pane.editor")!;
    const afterJump = verify(100);
    expect(afterJump.convertedRows).toBe(beforeJump.convertedRows);
    expect(afterJump.cachedRows).toBe(0);
    foreground = 0x123456;
    background = 0x654321;
    verify(100);
    palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "light" }));
    verify(100);
    consumerId = {};
    actual = buffers(width, height);
    verify(100);
    width = 80;
    height = 20;
    actual = buffers(width, height);
    verify(100, { x: 5, y: -100 });
    verify(100, { x: 9, y: -100 });
    width = 8;
    actual = buffers(width, height);
    verify(100, { x: 1, y: -100 });
    width = 80;
    actual = buffers(width, height);
    const release = renderer.retainPaneView("pane.editor")!;
    verify(100);
    renderer.setNativePaneGeometries([{ paneId: "pane.editor", cols: 160, rows: 40 }]);
    verify(100);
    release();
    verify(100);
    verify(0);
    const replacement = {
      ...snapshot,
      history: snapshot.history.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => ({ ...cell, attributes: 16 })),
      })),
    };
    source.emit("pane.editor", {
      ...initial,
      revision: 1,
      cols: 200,
      rows: 54,
      snapshot: replacement,
      stateHash: hashTerminalReplicaSnapshot(replacement),
    });
    verify(100);
    width = 1024;
    height = 64;
    actual = buffers(width, height);
    expect(verify(100).cachedRows).toBe(0);
  } finally {
    stop();
    renderer.dispose();
    lane.dispose();
  }
});
