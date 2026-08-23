import { describe, expect, it } from "vitest";
import { widgetMarkerAnnouncement, type CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import type { CausalCellProbeV1 } from "@tmux-ide/contracts";
import { hashTerminalReplicaSnapshot, TERMINAL_CONFORMANCE_FIXTURES } from "@tmux-ide/core";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import type {
  TerminalInterpreterBackend,
  TerminalInterpreterBackendFactory,
} from "./terminal-interpreter-backend.ts";
import type { SessionRuntimeTraceContext } from "./runtime-observability.ts";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";

const generation = "00000000-0000-4000-8000-000000000001";

function create(updates: CanonicalTerminalReplicaUpdate[], cols = 12, rows = 3) {
  return new TerminalReplicaInterpreter({
    generation,
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    incarnation: `${generation}:0`,
    cols,
    rows,
    onUpdate: (update) => updates.push(update),
  });
}

describe("TerminalReplicaInterpreter", () => {
  it("keeps the explicit ANSI baseline exact across reset, geometry reseed, and alt restore", async () => {
    const marker = "ANSI_BASELINE_MARKER";
    const baseline = `\u001b[3J\u001b[2J\u001b[H\u001b[2 q\u001b[?25h${marker}\u001b[2;1H`;
    const normalize = "\u001b[0m\u001b[2;1H\u001b[2 q\u001b[?25h";
    const interpreter = new TerminalReplicaInterpreter({
      generation,
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: `${generation}:0`,
      cols: 132,
      rows: 41,
      backendFactory: createXtermTerminalInterpreterBackend,
    });
    const reseed = () =>
      interpreter.enqueue({
        type: "reseed",
        cols: 132,
        rows: 41,
        chunks: [new TextEncoder().encode(baseline)],
        cursor: { x: 0, y: 1 },
        bootstrap: "painted-capture",
      });
    await reseed();
    const expected = structuredClone(interpreter.currentSnapshot());
    expect(expected.cursor).toEqual({ x: 0, y: 1, hidden: false, style: "block", blink: false });

    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode(baseline) });
    expect(interpreter.currentSnapshot()).toEqual(expected);

    await interpreter.enqueue({
      type: "write",
      data: new TextEncoder().encode(
        `${baseline}\u001b[?1049h\u001b[2J\u001b[HALT_SCREEN\u001b[8;12H\u001b[4 q\u001b[?25l`,
      ),
    });
    expect(interpreter.currentSnapshot()).toMatchObject({
      cursor: { x: 11, y: 7, hidden: true, style: "underline", blink: false },
      modes: { alternateScreen: true },
    });
    await interpreter.enqueue({
      type: "write",
      data: new TextEncoder().encode(`\u001b[?1049l${normalize}`),
    });
    expect(interpreter.currentSnapshot()).toEqual(expected);

    await interpreter.enqueue({
      type: "write",
      data: new TextEncoder().encode(
        "\u001b[?1049h\u001b[2J\u001b[HALT_SCREEN\u001b[8;12H\u001b[4 q\u001b[?25l",
      ),
    });
    await interpreter.enqueue({
      type: "write",
      data: new TextEncoder().encode(`\u001b[?1049l\u001b[HRETURN_BROKEN${normalize}`),
    });
    expect(interpreter.currentSnapshot().cursor).toEqual(expected.cursor);
    expect(interpreter.currentSnapshot().modes).toEqual(expected.modes);
    expect(interpreter.currentSnapshot()).not.toEqual(expected);

    await reseed();
    expect(interpreter.currentSnapshot()).toEqual(expected);
  });

  it("projects exact mouse protocol and encoding modes from the production parser", async () => {
    const interpreter = create([]);
    await interpreter.enqueue({
      type: "reseed",
      cols: 12,
      rows: 3,
      chunks: [new TextEncoder().encode("\u001b[?1002h\u001b[?1006h")],
      cursor: { x: 0, y: 0 },
      bootstrap: "authoritative-stream",
    });
    expect(interpreter.currentSnapshot().modes).toMatchObject({
      mouseTracking: true,
      mouseProtocol: "drag",
      mouseEncoding: "sgr",
    });
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("\u001b[?1003h") });
    expect(interpreter.currentSnapshot().modes.mouseProtocol).toBe("any");
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("\u001b[?1006l") });
    expect(interpreter.currentSnapshot().modes.mouseEncoding).toBe("default");
    await interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it.each([
    ["key", "x"],
    ["multi-byte paste", "PASTE0Q"],
  ])(
    "proves exactly one default-rendition cell after the production 160x42 to 132x41 %s lifecycle",
    async (_label, text) => {
      const interpreter = new TerminalReplicaInterpreter({
        generation,
        workspaceName: "workspace",
        semanticPaneId: "pane-a",
        incarnation: `${generation}:0`,
        cols: 160,
        rows: 42,
        backendFactory: createXtermTerminalInterpreterBackend,
      });
      await interpreter.enqueue({
        type: "reseed",
        cols: 160,
        rows: 42,
        chunks: [
          new TextEncoder().encode(
            "\u001b[31mold\u001b[0m\u001b[2J\u001b[3J\u001b[?7l\u001b[1;160H\u001b[2K\u001b[1;160H \u001b[1;160H",
          ),
        ],
        cursor: { x: 159, y: 0 },
        bootstrap: "authoritative-stream",
      });
      await interpreter.enqueue({ type: "resize", cols: 132, rows: 41 });
      await interpreter.enqueue({
        type: "write",
        data: new TextEncoder().encode(
          "\u001b[0m\u001b[2J\u001b[3J\u001b[?7l\u001b[1;132H\u001b[2K\u001b[1;132H \u001b[1;132H",
        ),
      });
      const seed = interpreter.currentSeed()!;
      expect(seed.snapshot).toMatchObject({ cols: 132, rows: 41 });
      expect(seed.stateHash).toBe(hashTerminalReplicaSnapshot(seed.snapshot));
      expect(seed.snapshot.grid[0]!.wrapped).toBe(false);
      const before = seed.snapshot.grid[0]!.cells[131]!;
      const probe: CausalCellProbeV1 = {
        version: 1,
        capability: "causal-cell-v1",
        traceId: "00000000-0000-4000-8000-000000000099",
        clientId: "client:test",
        transportNonce: "00000000-0000-4000-8000-000000000010",
        deliveryNonce: "00000000-0000-4000-8000-000000000011",
        inputSequence: 1,
        semanticPaneId: "pane-a",
        generation,
        incarnation: `${generation}:0`,
        baselineRevision: seed.revision,
        baselineStateHash: seed.stateHash,
        geometry: { cols: 132, rows: 41, row: 0, column: 131 },
        before,
        after: { ...before, grapheme: text.at(-1)! },
      };
      const results: unknown[] = [];
      interpreter.armCausalCellProbe(probe, (result) => results.push(result));
      interpreter.noteCausalCellControlReply(probe.traceId, true);
      await interpreter.enqueue({
        type: "write",
        data: new TextEncoder().encode(
          `\u001b]6973;tmux-ide-causal-cell-v1;start;${probe.traceId}\u0007${text}\u001b]6973;tmux-ide-causal-cell-v1;end;${probe.traceId}\u0007`,
        ),
      });
      expect(results).toEqual([
        expect.objectContaining({
          status: "proved",
          proof: expect.objectContaining({ committedRevision: seed.revision + 1 }),
        }),
      ]);
      const next = interpreter.currentSnapshot();
      expect(hashTerminalReplicaSnapshot(next)).toBe(
        (results[0] as { proof: { committedStateHash: string } }).proof.committedStateHash,
      );
      expect(next.cursor).toEqual(seed.snapshot.cursor);
      expect(next.modes).toEqual(seed.snapshot.modes);
      expect(next.history).toEqual(seed.snapshot.history);
      expect(next.grid.map((row) => row.wrapped)).toEqual(
        seed.snapshot.grid.map((row) => row.wrapped),
      );
      expect(
        next.grid.flatMap((row, rowIndex) =>
          row.cells.flatMap((cell, column) =>
            JSON.stringify(cell) === JSON.stringify(seed.snapshot.grid[rowIndex]!.cells[column])
              ? []
              : [{ row: rowIndex, column }],
          ),
        ),
      ).toEqual([{ row: 0, column: 131 }]);
      await interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
    },
  );

  it("keeps parser lifecycle behind the backend seam without moving canonical authority", async () => {
    const created: TerminalInterpreterBackend[] = [];
    let disposed = 0;
    const backendFactory: TerminalInterpreterBackendFactory = (options) => {
      const delegate = createXtermTerminalInterpreterBackend(options);
      const backend: TerminalInterpreterBackend = {
        kind: delegate.kind,
        get cols() {
          return delegate.cols;
        },
        get rows() {
          return delegate.rows;
        },
        prioritizeNextWrite: () => delegate.prioritizeNextWrite(),
        write: (data) => delegate.write(data),
        resize: (cols, rows) => delegate.resize(cols, rows),
        setAuthoritativeCursor: (x, y) => delegate.setAuthoritativeCursor(x, y),
        modes: () => delegate.modes(),
        dirtyRange: () => delegate.dirtyRange(),
        project: (previous, dirty) => delegate.project(previous, dirty),
        dispose: () => {
          disposed += 1;
          delegate.dispose();
        },
      };
      created.push(backend);
      return backend;
    };
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = new TerminalReplicaInterpreter({
      generation,
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: `${generation}:0`,
      cols: 8,
      rows: 2,
      backendFactory,
      onUpdate: (update) => updates.push(update),
    });
    await interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 2,
      chunks: [new TextEncoder().encode("\u001b[31mA")],
      cursor: { x: 1, y: 0 },
      bootstrap: "authoritative-stream",
    });
    expect(created).toHaveLength(2);
    expect(disposed).toBe(1);
    expect(interpreter.currentSnapshot().grid[0]!.cells[0]).toMatchObject({
      grapheme: "A",
      foreground: { kind: "indexed", index: 1 },
    });
    expect(updates).toHaveLength(1);
    await interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
    expect(disposed).toBe(2);
  });

  it("consumes one priority on the next actual write and arms a reseed replacement, not its predecessor", async () => {
    const events: string[][] = [];
    const backendFactory: TerminalInterpreterBackendFactory = (options) => {
      const ownEvents: string[] = [];
      events.push(ownEvents);
      const delegate = createXtermTerminalInterpreterBackend(options);
      return {
        kind: delegate.kind,
        get cols() {
          return delegate.cols;
        },
        get rows() {
          return delegate.rows;
        },
        prioritizeNextWrite: () => {
          ownEvents.push("priority");
          delegate.prioritizeNextWrite();
        },
        write: (data) => {
          ownEvents.push(
            `write:${typeof data === "string" ? data : new TextDecoder().decode(data)}`,
          );
          return delegate.write(data);
        },
        resize: (cols, rows) => delegate.resize(cols, rows),
        setAuthoritativeCursor: (x, y) => delegate.setAuthoritativeCursor(x, y),
        modes: () => delegate.modes(),
        dirtyRange: () => delegate.dirtyRange(),
        project: (previous, dirty) => delegate.project(previous, dirty),
        dispose: () => delegate.dispose(),
      };
    };
    const interpreter = new TerminalReplicaInterpreter({
      generation,
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: `${generation}:0`,
      cols: 8,
      rows: 2,
      backendFactory,
    });
    interpreter.prioritizeNextWrite();
    interpreter.prioritizeNextWrite();
    await interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 2,
      chunks: [new TextEncoder().encode("A"), new TextEncoder().encode("B")],
      cursor: { x: 2, y: 0 },
      bootstrap: "authoritative-stream",
    });
    expect(events[0]).toEqual([]);
    expect(events[1]).toEqual(["priority", "write:A", "write:B"]);

    interpreter.prioritizeNextWrite();
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("C") });
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("D") });
    expect(events[1]).toEqual(["priority", "write:A", "write:B", "priority", "write:C", "write:D"]);
    await interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("does not spend interactive priority on synthetic synchronized-output recovery", async () => {
    const events: string[] = [];
    let recover: (() => void) | null = null;
    const backendFactory: TerminalInterpreterBackendFactory = (options) => {
      const delegate = createXtermTerminalInterpreterBackend(options);
      return {
        kind: delegate.kind,
        get cols() {
          return delegate.cols;
        },
        get rows() {
          return delegate.rows;
        },
        prioritizeNextWrite: () => {
          events.push("priority");
          delegate.prioritizeNextWrite();
        },
        write: (data) => {
          events.push(`write:${typeof data === "string" ? data : new TextDecoder().decode(data)}`);
          return delegate.write(data);
        },
        resize: (cols, rows) => delegate.resize(cols, rows),
        setAuthoritativeCursor: (x, y) => delegate.setAuthoritativeCursor(x, y),
        modes: () => delegate.modes(),
        dirtyRange: () => delegate.dirtyRange(),
        project: (previous, dirty) => delegate.project(previous, dirty),
        dispose: () => delegate.dispose(),
      };
    };
    const interpreter = new TerminalReplicaInterpreter({
      generation,
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: `${generation}:0`,
      cols: 8,
      rows: 2,
      backendFactory,
      scheduler: {
        nowMs: () => 0,
        createId: () => "scheduler-id",
        microtask: (task) => queueMicrotask(task),
        timer: (task) => {
          recover = task;
          return { cancel: () => (recover = null) };
        },
      },
    });
    await interpreter.enqueue({
      type: "write",
      data: new TextEncoder().encode("\u001b[?2026hwaiting"),
    });
    interpreter.prioritizeNextWrite();
    expect(recover).not.toBeNull();
    (recover as () => void)();
    await interpreter.whenIdle();
    expect(events).toEqual(["write:\u001b[?2026hwaiting", "write:\u001b[?2026l"]);

    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("X") });
    expect(events).toEqual([
      "write:\u001b[?2026hwaiting",
      "write:\u001b[?2026l",
      "priority",
      "write:X",
    ]);
    await interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("keeps the injected xterm oracle differential-identical to the default path", async () => {
    const defaultUpdates: CanonicalTerminalReplicaUpdate[] = [];
    const injectedUpdates: CanonicalTerminalReplicaUpdate[] = [];
    const options = {
      generation,
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: `${generation}:0`,
      cols: 10,
      rows: 3,
    } as const;
    const defaultInterpreter = new TerminalReplicaInterpreter({
      ...options,
      onUpdate: (update) => defaultUpdates.push(update),
    });
    const injectedInterpreter = new TerminalReplicaInterpreter({
      ...options,
      backendFactory: createXtermTerminalInterpreterBackend,
      onUpdate: (update) => injectedUpdates.push(update),
    });
    const operations = [
      {
        type: "reseed",
        cols: 10,
        rows: 3,
        chunks: [new TextEncoder().encode("\u001b[31mA界\u001b[0m")],
        cursor: { x: 3, y: 0 },
        bootstrap: "authoritative-stream",
      },
      { type: "write", data: new TextEncoder().encode("\r\nB\u001b[?25l") },
      { type: "resize", cols: 12, rows: 4 },
      { type: "cursor", x: 2, y: 1 },
    ] as const;
    for (const operation of operations) {
      await defaultInterpreter.enqueue(operation);
      await injectedInterpreter.enqueue(operation);
      expect(injectedInterpreter.currentSnapshot()).toEqual(defaultInterpreter.currentSnapshot());
    }
    expect(injectedUpdates).toEqual(defaultUpdates);
  });

  it("does not coalesce external bytes across an authenticated trace boundary", async () => {
    const observed: Array<SessionRuntimeTraceContext | null> = [];
    const interpreter = new TerminalReplicaInterpreter({
      generation,
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: `${generation}:0`,
      cols: 12,
      rows: 3,
      onUpdate: (_update, trace) => observed.push(trace),
    });
    await interpreter.enqueue({
      type: "reseed",
      cols: 12,
      rows: 3,
      chunks: [],
      cursor: { x: 0, y: 0 },
      bootstrap: "painted-capture",
    });
    observed.length = 0;
    const trace: SessionRuntimeTraceContext = {
      traceId: "00000000-0000-4000-8000-000000000099",
      scenario: "terminal-input-to-paint",
      authority: { generation, incarnation: `${generation}:0` },
    };
    await Promise.all([
      interpreter.enqueue({ type: "write", data: new TextEncoder().encode("A") }),
      interpreter.enqueue({ type: "write", data: new TextEncoder().encode("B"), trace }),
    ]);
    expect(observed).toEqual([null, trace]);

    observed.length = 0;
    await Promise.all([
      interpreter.enqueue({ type: "write", data: new TextEncoder().encode("C"), trace }),
      interpreter.enqueue({ type: "write", data: new TextEncoder().encode("D") }),
    ]);
    expect(observed).toEqual([trace, null]);
  });

  it("publishes one atomic painted-capture seed and orders resize after partial CSI", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = create(updates);
    expect(interpreter.currentSeed()).toBeNull();
    await interpreter.enqueue({
      type: "reseed",
      cols: 12,
      rows: 3,
      chunks: [new TextEncoder().encode("A\u001b[31"), new TextEncoder().encode("mB")],
      cursor: { x: 2, y: 0 },
      bootstrap: "painted-capture",
    });
    await interpreter.enqueue({ type: "resize", cols: 10, rows: 2 });
    expect(updates.map((update) => update.type)).toEqual(["terminal.seed", "terminal.patch"]);
    expect(interpreter.currentSeed()?.stateHash).toBe(updates[1]!.stateHash);
    expect(updates.map((update) => update.revision)).toEqual([0, 1]);
    expect(interpreter.currentSnapshot().grid[0]!.cells[1]!.foreground).toEqual({
      kind: "indexed",
      index: 1,
    });
    expect(interpreter.currentSnapshot()).toMatchObject({ cols: 10, rows: 2 });
  });

  it.each(["top", "bottom"] as const)(
    "makes one dual-geometry %s seed semantically equal to native seed then visible resize",
    async () => {
      const chunks = [
        new TextEncoder().encode("one界e\u0301\r\ntwo\r\nthree\r\nfour\u001b[31mR\u001b[?25l"),
        new TextEncoder().encode("\u001b[?7l\u001b[2;3H界e\u0301"),
      ];
      const legacyUpdates: CanonicalTerminalReplicaUpdate[] = [];
      const atomicUpdates: CanonicalTerminalReplicaUpdate[] = [];
      const legacy = create(legacyUpdates, 8, 3);
      const atomic = create(atomicUpdates, 8, 3);
      await legacy.enqueue({
        type: "reseed",
        cols: 8,
        rows: 3,
        chunks,
        cursor: { x: 4, y: 1 },
        bootstrap: "painted-capture",
      });
      await legacy.enqueue({ type: "resize", cols: 8, rows: 4 });
      await atomic.enqueue({
        type: "reseed",
        nativeCols: 8,
        nativeRows: 3,
        cols: 8,
        rows: 4,
        chunks,
        cursor: { x: 4, y: 1 },
        bootstrap: "painted-capture",
      });
      expect(atomic.currentSnapshot()).toEqual(legacy.currentSnapshot());
      expect(atomic.currentSnapshot().cursor).toMatchObject({ x: 4, y: 1 });
      expect(atomic.currentSnapshot().modes).toEqual(legacy.currentSnapshot().modes);
      expect(atomicUpdates.map((update) => update.type)).toEqual(["terminal.seed"]);
      expect(legacyUpdates.map((update) => update.type)).toEqual([
        "terminal.seed",
        "terminal.patch",
      ]);
    },
  );

  it("parses held deltas at native geometry and discards a crossed lease before commit", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    let valid = false;
    let invalidated = 0;
    const interpreter = create(updates, 8, 3);
    await interpreter.enqueue({
      type: "reseed",
      nativeCols: 8,
      nativeRows: 3,
      cols: 8,
      rows: 4,
      chunks: [new TextEncoder().encode("capture"), new TextEncoder().encode("-held")],
      cursor: { x: 4, y: 1 },
      bootstrap: "painted-capture",
      validateBeforeCommit: () => valid,
      onInvalidated: () => (invalidated += 1),
    });
    expect(invalidated).toBe(1);
    expect(updates).toEqual([]);
    expect(interpreter.currentSeed()).toBeNull();
    valid = true;
    await interpreter.enqueue({
      type: "reseed",
      nativeCols: 8,
      nativeRows: 3,
      cols: 8,
      rows: 4,
      chunks: [new TextEncoder().encode("capture"), new TextEncoder().encode("-held")],
      cursor: { x: 4, y: 1 },
      bootstrap: "painted-capture",
      validateBeforeCommit: () => valid,
    });
    expect(updates.map((update) => update.type)).toEqual(["terminal.seed"]);
    expect(interpreter.currentSnapshot()).toMatchObject({ cols: 8, rows: 4 });
  });

  it("keeps tmux cursor truth absolute under DECOM without mutating parser state", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = create(updates, 20, 8);
    await interpreter.enqueue({
      type: "reseed",
      cols: 20,
      rows: 8,
      chunks: [new TextEncoder().encode("\u001b[2;6r\u001b[?6hhello")],
      cursor: { x: 17, y: 7 },
      bootstrap: "painted-capture",
    });
    expect(interpreter.currentSnapshot().cursor).toMatchObject({ x: 17, y: 7 });
    expect(interpreter.currentSnapshot().modes.origin).toBe(true);
  });

  it("makes corrected cursor authoritative for the next relative write", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = create(updates, 10, 2);
    await interpreter.enqueue({
      type: "reseed",
      cols: 10,
      rows: 2,
      chunks: [new TextEncoder().encode("abc")],
      cursor: { x: 1, y: 0 },
      bootstrap: "painted-capture",
    });
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("Z") });
    expect(
      interpreter
        .currentSnapshot()
        .grid[0]!.cells.slice(0, 3)
        .map((cell) => cell.grapheme)
        .join(""),
    ).toBe("aZc");
    expect(interpreter.currentSnapshot().cursor.x).toBe(2);
  });

  it("invalidates a cached row when xterm's combined-grapheme side table changes", async () => {
    const interpreter = create([], 8, 2);
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("e\u0301") });
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("\ra\u0301") });
    expect(interpreter.currentSnapshot().grid[0]!.cells[0]!.grapheme).toBe("a\u0301");
  });

  it("coalesces a same-turn flood, emits no semantic no-op, and is idle at zero cost", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = create(updates, 80, 24);
    expect(interpreter.gridWalkCount()).toBe(0);
    const writes = Array.from({ length: 200 }, () =>
      interpreter.enqueue({ type: "write", data: new TextEncoder().encode("x") }),
    );
    await Promise.all(writes);
    expect(interpreter.gridWalkCount()).toBe(1);
    expect(updates).toHaveLength(1);
    const before = interpreter.gridWalkCount();
    await interpreter.whenIdle();
    expect(interpreter.gridWalkCount()).toBe(before);
    const count = updates.length;
    await interpreter.enqueue({ type: "cursor", x: 0, y: 0 });
    await interpreter.enqueue({ type: "cursor", x: 0, y: 0 });
    expect(updates.length).toBeLessThanOrEqual(count + 1);
  });

  it("matches shared ANSI, inverse, wide and combining conformance fixtures", async () => {
    for (const fixture of TERMINAL_CONFORMANCE_FIXTURES) {
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const interpreter = create(updates, fixture.cols, fixture.rows);
      await interpreter.enqueue({
        type: "reseed",
        cols: fixture.cols,
        rows: fixture.rows,
        chunks: fixture.writes.map((write) => new TextEncoder().encode(write)),
        cursor: { x: 0, y: 0 },
        bootstrap: "authoritative-stream",
      });
      const snapshot = interpreter.currentSnapshot();
      for (const expected of fixture.cells) {
        const actual = snapshot.grid[expected.row]!.cells[expected.column]!;
        expect(actual, `${fixture.id} ${expected.row}:${expected.column}`).toMatchObject({
          grapheme: expected.chars,
          width: expected.width,
          foreground: expected.foreground,
          background: expected.background,
          attributes: attributeBits(expected.attributes ?? []),
        });
      }
      expect(
        snapshot.grid.flatMap((row, index) => (row.wrapped ? [index] : [])),
        `${fixture.id} wrapped rows`,
      ).toEqual(fixture.wrappedRows ?? []);
      if (fixture.historyRows !== undefined)
        expect(snapshot.history, `${fixture.id} history`).toHaveLength(fixture.historyRows);
      if (fixture.cursor) expect(snapshot.cursor, `${fixture.id} cursor`).toEqual(fixture.cursor);
      if (fixture.modes) expect(snapshot.modes, `${fixture.id} modes`).toMatchObject(fixture.modes);
    }
  });

  it("uses a single higher-revision seed for reseed and immutable tombstone after it", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = create(updates);
    const reseed = (text: string) =>
      interpreter.enqueue({
        type: "reseed",
        cols: 12,
        rows: 3,
        chunks: [new TextEncoder().encode(text)],
        cursor: { x: 0, y: 0 },
        bootstrap: "painted-capture",
      });
    await reseed("one");
    await reseed("two");
    await interpreter.enqueue({ type: "close", reason: "session-restarted" });
    expect(updates.map((update) => [update.type, update.revision])).toEqual([
      ["terminal.seed", 0],
      ["terminal.seed", 1],
      ["terminal.tombstone", 2],
    ]);
    expect(Object.isFrozen(interpreter.currentSnapshot().grid)).toBe(true);
  });

  it("does not retain the prior backend history across an authoritative reseed", async () => {
    const interpreter = create([], 6, 2);
    await interpreter.enqueue({
      type: "reseed",
      cols: 6,
      rows: 2,
      chunks: [new TextEncoder().encode("one\r\ntwo\r\nthree\r\nfour")],
      cursor: { x: 4, y: 1 },
      bootstrap: "authoritative-stream",
    });
    expect(interpreter.currentSnapshot().history.length).toBeGreaterThan(0);
    await interpreter.enqueue({
      type: "reseed",
      cols: 6,
      rows: 2,
      chunks: [new TextEncoder().encode("fresh")],
      cursor: { x: 5, y: 0 },
      bootstrap: "authoritative-stream",
    });
    expect(interpreter.currentSnapshot().history).toEqual([]);
  });

  it("withholds synchronized-output intermediates and publishes the final atomic frame", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = create(updates);
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("\u001b[?2026hA") });
    expect(updates).toHaveLength(0);
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("B\u001b[?2026l") });
    expect(updates).toHaveLength(1);
    expect(
      interpreter
        .currentSnapshot()
        .grid[0]!.cells.slice(0, 2)
        .map((cell) => cell.grapheme)
        .join(""),
    ).toBe("AB");
  });

  it("applies admitted resize geometry before later synchronized bytes parse", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = create(updates, 4, 2);
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("\u001b[?2026h") });
    await interpreter.enqueue({ type: "resize", cols: 2, rows: 3 });
    await interpreter.enqueue({
      type: "write",
      data: new TextEncoder().encode("\u001b[?2026lABCD"),
    });
    expect(interpreter.currentSnapshot()).toMatchObject({ cols: 2, rows: 3 });
    expect(interpreter.currentSnapshot().grid[1]!.cells[0]!.grapheme).toBe("C");
    expect(updates).toHaveLength(1);
  });

  it("projects and clears authenticated rich-widget placements", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = create(updates, 80, 8);
    await interpreter.enqueue({
      type: "reseed",
      cols: 80,
      rows: 8,
      chunks: [new TextEncoder().encode(widgetMarkerAnnouncement("markdown", { text: "# Plan" }))],
      cursor: { x: 0, y: 1 },
      bootstrap: "authoritative-stream",
    });
    expect(interpreter.currentSnapshot().placements[0]).toMatchObject({
      id: "markdown",
      kind: "widget",
      row: 0,
      column: 0,
      rows: 8,
      columns: 80,
    });
    await interpreter.enqueue({
      type: "write",
      data: new TextEncoder().encode("\u001b[2J\u001b[3J\u001b[Hshell"),
    });
    expect(interpreter.currentSnapshot().placements).toEqual([]);
  });

  it("discovers a wrapped widget announcement whose sentinel has scrolled into history", async () => {
    const interpreter = create([], 20, 3);
    await interpreter.enqueue({
      type: "write",
      data: new TextEncoder().encode(
        widgetMarkerAnnouncement("markdown", { text: "x".repeat(4_000) }),
      ),
    });
    expect(interpreter.currentSnapshot().history.length).toBeGreaterThan(0);
    expect(interpreter.currentSnapshot().placements[0]?.id).toBe("markdown");
  });
});

function attributeBits(attributes: readonly string[]): number {
  const bits: Readonly<Record<string, number>> = {
    bold: 1,
    dim: 2,
    italic: 4,
    underline: 8,
    blink: 16,
    inverse: 32,
    hidden: 64,
    strikethrough: 128,
  };
  return attributes.reduce((value, attribute) => value | (bits[attribute] ?? 0), 0);
}
