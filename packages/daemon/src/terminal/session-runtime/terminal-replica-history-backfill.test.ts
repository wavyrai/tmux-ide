// #873: a native seed that leaves out the oldest history rows, and the
// backfill that prepends them piece by piece. tmux numbers history rows from
// its oldest one; the replica holds rows M .. M+K-1 and counts the M rows it
// left out, so its collection at the history limit and the owner's
// history-size check stay in step with tmux.
import { describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate, TerminalReplicaRow } from "@tmux-ide/contracts";
import {
  admitTerminalDeliveryEnvelope,
  blankTerminalReplicaSnapshot,
  commitTerminalDelivery,
  completeTerminalDelivery,
  admitTerminalDeliveryChunk,
  createTerminalDeliveryClientState,
  hashTerminalReplicaSnapshot,
  TerminalDeliveryAssembler,
} from "@tmux-ide/core";
import type { TerminalDeliveryEnvelope, TerminalDeliveryServerMessage } from "@tmux-ide/contracts";
import {
  nativeHistoryPieceRows,
  type NativeGridCapture,
  type NativeGridCaptureRow,
  type NativeHistoryPiece,
  type NativeHistoryRequest,
} from "../mirror/native-grid-capture.ts";
import { projectNativeGridRow } from "../mirror/native-grid-projection.ts";
import type { MirrorSubscribeRequest, MirrorSubscription } from "../mirror/mirror-service.ts";
import type { MirrorPaneEvent } from "../mirror/events.ts";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";
import {
  DAEMON_HISTORY_ROW_CAP,
  type TerminalInterpreterBackend,
} from "./terminal-interpreter-backend.ts";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import {
  BACKFILL_ALTERNATE_WAIT_MS,
  BACKFILL_MAX_FAILURES,
  SessionRuntimeTerminalReplicaOwner,
  PARK_AFTER_MS,
} from "./terminal-replica-owner.ts";
import {
  SessionRuntimeTerminalDeliveryHub,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const COLS = 12;
const ROWS = 2;

function cell(text: string) {
  return {
    flags: 0,
    width: 1,
    bytesHex: Buffer.from(text).toString("hex"),
    text,
    attributes: 0,
    foreground: 8,
    background: 8,
    underline: 8,
    link: 0,
    storageFlags: 0,
  };
}

/** One tmux row holding `text`, padded with spaces; flags & 1 = wraps into the next. */
function nativeRow(text: string, flags = 0, cols = COLS): NativeGridCaptureRow {
  const padded = text.padEnd(cols, " ").slice(0, cols);
  return { flags, used: cols, cells: [...padded].map(cell) };
}

/** tmux's whole pane: `history` rows then `ROWS` screen rows, row n reads `R<n>`. */
function tmuxRows(history: number, wraps: readonly number[] = [], cols = COLS) {
  return Array.from({ length: history + ROWS }, (_, n) =>
    nativeRow(`R${n}`, wraps.includes(n) ? 1 : 0, cols),
  );
}

/** A tail capture: the newest `history - omitted` history rows and the screen. */
function tailCapture(
  rows: readonly NativeGridCaptureRow[],
  omitted: number,
  limit = 2000,
  cols = COLS,
): NativeGridCapture {
  const history = rows.length - ROWS;
  return {
    version: 2,
    currentAttributes: [0, 8, 8, 8],
    cols,
    rows: ROWS,
    history: history - omitted,
    ...(omitted > 0 ? { omittedHistory: omitted } : {}),
    hscrolled: 0,
    limit,
    cursor: [0, ROWS - 1],
    grid: rows.slice(omitted),
  };
}

function piece(
  rows: readonly NativeGridCaptureRow[],
  firstRow: number,
  count: number,
  historySize: number,
  cols = COLS,
): NativeHistoryPiece {
  return { cols, historySize, firstRow, rows: rows.slice(firstRow, firstRow + count) };
}

/** What the replica must show for tmux rows `from ..`: wrapped from the row before. */
function expectedRows(
  rows: readonly NativeGridCaptureRow[],
  from: number,
  to: number,
  cols = COLS,
): TerminalReplicaRow[] {
  const out: TerminalReplicaRow[] = [];
  for (let n = from; n < to; n++)
    out.push(projectNativeGridRow(rows[n], cols, 0, n > from && (rows[n - 1]!.flags & 1) !== 0)!);
  return out;
}

const text = (row: TerminalReplicaRow) =>
  row.cells
    .map((c) => c.grapheme)
    .join("")
    .trim();

type Backend = TerminalInterpreterBackend & {
  omittedHistory(): number;
  prependNativeHistory(piece: NativeHistoryPiece): boolean;
};

function seededBackend(capture: NativeGridCapture, limit = 2000, historyRowCap?: number): Backend {
  const backend = createXtermTerminalInterpreterBackend({
    cols: capture.cols,
    rows: capture.rows,
    scrollback: Math.max(limit, capture.history + (capture.omittedHistory ?? 0)),
    historyLimit: limit,
    ...(historyRowCap !== undefined ? { historyRowCap } : {}),
  }) as Backend;
  expect(backend.importNativeGrid!(capture)).toBe(true);
  backend.startHistoryCollection?.();
  return backend;
}

const project = (backend: TerminalInterpreterBackend) =>
  backend.project(blankTerminalReplicaSnapshot(backend.cols, backend.rows));

const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `\r\nL${from + i}`).join("");

describe("backend: rows a native seed left out (#873 point 1)", () => {
  it("counts the omitted rows of a tail seed, and none for a whole one", () => {
    const rows = tmuxRows(15);
    const tail = seededBackend(tailCapture(rows, 10));
    const whole = seededBackend(tailCapture(rows, 0));
    try {
      expect(tail.omittedHistory()).toBe(10);
      expect(project(tail).history.map(text)).toEqual(["R10", "R11", "R12", "R13", "R14"]);
      expect(whole.omittedHistory()).toBe(0);
    } finally {
      tail.dispose();
      whole.dispose();
    }
  });

  /** tmux's history_size after `scrolls` one-row scrolls from `size` (grid_collect_history). */
  function tmuxSize(limit: number, size: number, scrolls: number): number {
    for (let n = 0; n < scrolls; n++) {
      if (size > 0 && size >= limit) size -= Math.min(size, Math.max(1, Math.floor(limit / 10)));
      size += 1;
    }
    return size;
  }

  it.each([
    // limit, omitted, held, new lines
    [20, 5, 15, 1],
    [20, 1, 19, 1],
    [20, 3, 15, 9],
    [20, 2, 10, 40],
    [50, 30, 10, 25],
    // Fewer rows held than a tenth of the limit: the collection takes a full tenth.
    [50, 48, 2, 1],
  ])(
    "limit %i, %i left out, %i held, %i lines: tmux's history size is left out + held",
    async (limit, omitted, held, count) => {
      const backend = seededBackend(tailCapture(tmuxRows(omitted + held), omitted, limit), limit);
      try {
        await backend.write(lines(0, count));
        const expected = tmuxSize(limit, omitted + held, count);
        const history = project(backend).history;
        // The left-out rows are the oldest, so a collection takes them first.
        const dropped = omitted + held + count - expected;
        const left = Math.max(0, omitted - dropped);
        expect(history).toHaveLength(expected - left);
        const all = [
          ...Array.from({ length: omitted + held + ROWS }, (_, n) => `R${n}`),
          ...Array.from({ length: count }, (_, n) => `L${n}`),
        ];
        expect(history.map(text)).toEqual(all.slice(-ROWS - history.length, -ROWS));
        expect(backend.omittedHistory()).toBe(left);
      } finally {
        backend.dispose();
      }
    },
  );

  it("collects from the left-out rows first on a scroll-on-clear erase at the limit", async () => {
    const limit = 20;
    const backend = seededBackend(tailCapture(tmuxRows(20), 5, limit), limit);
    try {
      backend.setAuthoritativeModes({ scrollOnClear: true });
      await backend.write("\x1b[1;1HA\x1b[2;1HB");
      await backend.write("\x1b[2J");
      // Two used rows: collect 2 at 20 (left out 5 -> 3), 19 -> 20 after the second row.
      expect(backend.omittedHistory()).toBe(3);
      expect(project(backend).history).toHaveLength(17);
    } finally {
      backend.dispose();
    }
  });

  it("collects from the left-out rows on a scroll-on-clear erase over the limit", async () => {
    // A reflow can leave tmux holding more than its limit: 5 left out and 20 held.
    const limit = 20;
    const backend = seededBackend(tailCapture(tmuxRows(25), 5, limit), limit);
    try {
      backend.setAuthoritativeModes({ scrollOnClear: true });
      await backend.write("\x1b[1;1HA\x1b[2;1HB");
      await backend.write("\x1b[2J");
      // tmux: 25 -> 23 -> 24, then 24 -> 22 -> 23; both collections take left-out rows.
      expect(project(backend).history).toHaveLength(22);
      expect(backend.omittedHistory()).toBe(1);
    } finally {
      backend.dispose();
    }
  });
});

describe("backend: prepending a history piece (#873 point 2)", () => {
  // tmux holds 15 history rows; the seed left out the oldest 10.
  const wraps = [5, 9];
  const setup = () => {
    const rows = tmuxRows(15, wraps);
    const backend = seededBackend(tailCapture(rows, 10));
    project(backend);
    return { rows, backend };
  };

  it("prepends the rows below the oldest held row, wrapped as tmux wrapped them", () => {
    const { rows, backend } = setup();
    try {
      // The piece overlaps the held rows (R10..R13); only R4..R9 are new.
      expect(backend.prependNativeHistory(piece(rows, 4, 10, 15))).toBe(true);
      expect(backend.omittedHistory()).toBe(4);
      const projected = project(backend);
      expect(projected.history).toEqual(expectedRows(rows, 4, 15));
      // R9 wraps into R10: the old oldest row now continues the piece's last row.
      expect(projected.history[6]!.wrapped).toBe(true);
      expect(projected.grid).toEqual(expectedRows(rows, 15, 17));
    } finally {
      backend.dispose();
    }
  });

  it("keeps parsing at the screen after a prepend", async () => {
    const { rows, backend } = setup();
    try {
      expect(backend.prependNativeHistory(piece(rows, 0, 10, 15))).toBe(true);
      expect(backend.omittedHistory()).toBe(0);
      await backend.write("\r\nNEW");
      const projected = project(backend);
      expect(projected.history.map(text)).toEqual(Array.from({ length: 16 }, (_, n) => `R${n}`));
      expect(projected.grid.map(text)).toEqual(["R16", "NEW"]);
    } finally {
      backend.dispose();
    }
  });

  it.each([
    ["another width", (rows: NativeGridCaptureRow[]) => piece(rows, 4, 6, 15, COLS + 1)],
    ["a newer history size", (rows: NativeGridCaptureRow[]) => piece(rows, 4, 6, 16)],
    ["an older history size", (rows: NativeGridCaptureRow[]) => piece(rows, 4, 6, 14)],
    ["a gap before the held rows", (rows: NativeGridCaptureRow[]) => piece(rows, 2, 6, 15)],
    ["no row below the held rows", (rows: NativeGridCaptureRow[]) => piece(rows, 10, 3, 15)],
    ["an empty piece", (rows: NativeGridCaptureRow[]) => piece(rows, 9, 0, 15)],
    [
      "a negative first row",
      (rows: NativeGridCaptureRow[]) => ({ ...piece(rows, 0, 11, 15), firstRow: -1 }),
    ],
  ])("refuses %s and changes nothing", (_label, make) => {
    const { rows, backend } = setup();
    try {
      const before = project(backend);
      expect(backend.prependNativeHistory(make(rows))).toBe(false);
      expect(backend.omittedHistory()).toBe(10);
      const after = project(backend);
      expect(after.history).toEqual(before.history);
      expect(after.grid).toEqual(before.grid);
    } finally {
      backend.dispose();
    }
  });

  it("refuses a piece while the alternate screen is active", async () => {
    const { rows, backend } = setup();
    try {
      await backend.write("\x1b[?1049h");
      expect(backend.prependNativeHistory(piece(rows, 4, 6, 15))).toBe(false);
      expect(backend.omittedHistory()).toBe(10);
    } finally {
      backend.dispose();
    }
  });

  it("refuses a piece when nothing was left out", () => {
    const rows = tmuxRows(15);
    const backend = seededBackend(tailCapture(rows, 0));
    try {
      expect(backend.prependNativeHistory(piece(rows, 0, 5, 15))).toBe(false);
    } finally {
      backend.dispose();
    }
  });

  it("refuses a piece the parser has no room for", () => {
    const rows = tmuxRows(15);
    const backend = createXtermTerminalInterpreterBackend({
      cols: COLS,
      rows: ROWS,
      scrollback: 8,
      historyLimit: 8,
    }) as Backend;
    try {
      expect(backend.importNativeGrid!(tailCapture(rows, 10, 8))).toBe(true);
      expect(backend.prependNativeHistory(piece(rows, 0, 10, 15))).toBe(false);
      expect(project(backend).history.map(text)).toEqual(["R10", "R11", "R12", "R13", "R14"]);
    } finally {
      backend.dispose();
    }
  });

  it("prepends up to the parser's capacity and no further", () => {
    const rows = tmuxRows(15);
    const make = () => {
      const backend = createXtermTerminalInterpreterBackend({
        cols: COLS,
        rows: ROWS,
        scrollback: 8,
        historyLimit: 8,
      }) as Backend;
      expect(backend.importNativeGrid!(tailCapture(rows, 10, 8))).toBe(true);
      return backend;
    };
    // Capacity is 9 history rows (the limit and one) plus the screen; 5 are held.
    const fits = make();
    const over = make();
    try {
      expect(over.prependNativeHistory(piece(rows, 5, 5, 15))).toBe(false);
      expect(fits.prependNativeHistory(piece(rows, 6, 4, 15))).toBe(true);
      expect(project(fits).history.map(text)).toEqual(
        Array.from({ length: 9 }, (_, n) => `R${n + 6}`),
      );
    } finally {
      fits.dispose();
      over.dispose();
    }
  });

  it("collects at the limit after a prepend from the rows it now holds", async () => {
    const limit = 20;
    const rows = tmuxRows(20);
    const backend = seededBackend(tailCapture(rows, 8, limit), limit);
    try {
      expect(backend.prependNativeHistory(piece(rows, 0, 8, 20))).toBe(true);
      await backend.write(lines(0, 1));
      expect(backend.omittedHistory()).toBe(0);
      const history = project(backend).history;
      expect(history).toHaveLength(19);
      expect(text(history[0]!)).toBe("R2");
    } finally {
      backend.dispose();
    }
  });
});

function interpreterRig(
  onUpdate?: (update: CanonicalTerminalReplicaUpdate) => void,
  historyRowCap?: number,
) {
  const updates: CanonicalTerminalReplicaUpdate[] = [];
  const interpreter = new TerminalReplicaInterpreter({
    ...(historyRowCap !== undefined ? { historyRowCap } : {}),
    generation,
    workspaceName: "w",
    semanticPaneId: "pane",
    incarnation: `${generation}:0`,
    cols: COLS,
    rows: ROWS,
    onUpdate: (update) => {
      updates.push(update);
      onUpdate?.(update);
    },
  });
  const reseed = (native?: NativeGridCapture, data = "") =>
    interpreter.enqueue({
      type: "reseed",
      cols: COLS,
      rows: ROWS,
      chunks: data ? [new TextEncoder().encode(data)] : [],
      cursor: { x: 0, y: ROWS - 1 },
      bootstrap: "painted-capture",
      ...(native
        ? {
            native,
            historyLimit: native.limit,
            historySize: native.history + (native.omittedHistory ?? 0),
          }
        : {}),
    });
  return { interpreter, updates, reseed };
}

type Interpreter = TerminalReplicaInterpreter & {
  omittedHistory(): number;
  prependNativeHistory(piece: NativeHistoryPiece): Promise<boolean>;
};

describe("interpreter: the left-out count and the prepend operation (#873 points 2 and 5)", () => {
  it("sets the count per seed: a native tail seed sets it, any other seed clears it", async () => {
    const { interpreter, reseed } = interpreterRig();
    const i = interpreter as Interpreter;
    const rows = tmuxRows(15);
    await reseed(tailCapture(rows, 10));
    expect(i.omittedHistory()).toBe(10);
    await reseed(tailCapture(rows, 0));
    expect(i.omittedHistory()).toBe(0);
    await reseed(tailCapture(rows, 7));
    expect(i.omittedHistory()).toBe(7);
    await reseed(undefined, "painted");
    expect(i.omittedHistory()).toBe(0);
  });

  it("applies a piece in order with writes and publishes the grown history", async () => {
    const { interpreter, updates, reseed } = interpreterRig();
    const i = interpreter as Interpreter;
    const rows = tmuxRows(15);
    await reseed(tailCapture(rows, 10));
    const seedRevision = interpreter.currentSeed()!.revision;
    // tmux scrolls one more row into history; the piece was read after it.
    const write = interpreter.enqueue({ type: "write", data: new TextEncoder().encode("\r\nX") });
    const applied = i.prependNativeHistory(piece(rows, 0, 10, 16));
    await write;
    expect(await applied).toBe(true);
    expect(i.omittedHistory()).toBe(0);
    const snapshot = interpreter.currentSnapshot();
    expect(snapshot.history.map(text)).toEqual(Array.from({ length: 16 }, (_, n) => `R${n}`));
    const last = updates.at(-1)!;
    expect(last.revision).toBeGreaterThan(seedRevision);
    expect(last.stateHash).toBe(hashTerminalReplicaSnapshot(snapshot));
  });

  it("refuses a piece inside a synchronized update", async () => {
    const { interpreter, updates, reseed } = interpreterRig();
    const i = interpreter as Interpreter;
    const rows = tmuxRows(15);
    await reseed(tailCapture(rows, 10));
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("\x1b[?2026h") });
    const count = updates.length;
    expect(await i.prependNativeHistory(piece(rows, 0, 10, 15))).toBe(false);
    expect(updates).toHaveLength(count);
    expect(i.omittedHistory()).toBe(10);
  });

  it("refuses a piece read before a write it is queued behind, and publishes nothing", async () => {
    const { interpreter, updates, reseed } = interpreterRig();
    const i = interpreter as Interpreter;
    const rows = tmuxRows(15);
    await reseed(tailCapture(rows, 10));
    const write = interpreter.enqueue({ type: "write", data: new TextEncoder().encode("\r\nX") });
    const applied = i.prependNativeHistory(piece(rows, 0, 10, 15));
    await write;
    const count = updates.length;
    expect(await applied).toBe(false);
    expect(updates).toHaveLength(count);
    expect(i.omittedHistory()).toBe(10);
  });
});

describe("delivery hub: a history grown at its old end (#873 point 2)", () => {
  class Source implements TerminalDeliverySourceOwner {
    listener: ((update: CanonicalTerminalReplicaUpdate) => void) | undefined;
    async subscribeSource(listener: (update: CanonicalTerminalReplicaUpdate) => void) {
      this.listener = listener;
      return { generation, semanticPaneId: "pane", close: async () => {} };
    }
  }
  const settle = async () => {
    for (let n = 0; n < 8; n++) await new Promise<void>((r) => setImmediate(r));
  };

  async function client(hub: SessionRuntimeTerminalDeliveryHub, id: string, partial: boolean) {
    const messages: TerminalDeliveryServerMessage[] = [];
    const c = await hub.open(
      id,
      "pane",
      {
        protocolVersions: partial ? [1, 122, 124] : [1],
        encodings: ["semantic-compact-v1"],
        richPlacements: false,
      },
      (m) => {
        messages.push(m);
      },
    );
    if (!c.negotiation.accepted) throw new Error("not negotiated");
    const self = {
      state: createTerminalDeliveryClientState(c.negotiation.negotiated, "w", "pane"),
      envelopes: [] as TerminalDeliveryEnvelope[],
      processed: 0,
      drain() {
        for (; self.processed < messages.length; self.processed++) {
          const m = messages[self.processed]!;
          if (m.type !== "terminal.delivery") continue;
          const e = m as TerminalDeliveryEnvelope;
          let admitted = admitTerminalDeliveryEnvelope(self.state, e);
          expect(admitted.failed).toBe(false);
          const a = new TerminalDeliveryAssembler(e);
          for (const chunk of messages)
            if (
              chunk.type === "terminal.delivery.chunk" &&
              chunk.transactionId === e.transactionId
            ) {
              admitted = admitTerminalDeliveryChunk(admitted, chunk);
              a.write(chunk);
            }
          const result = commitTerminalDelivery(admitted, completeTerminalDelivery(admitted, a));
          self.state = result.state;
          self.envelopes.push(e);
          c.ack(result.ack as never);
        }
      },
    };
    return self;
  }

  it("sends both a partial and a complete client a state that hashes as the replica", async () => {
    const source = new Source();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "w", () => source);
    const partial = await client(hub, "partial", true);
    const full = await client(hub, "full", false);
    await settle();
    const { interpreter, reseed } = interpreterRig((update) => source.listener!(update));
    const i = interpreter as Interpreter;
    const rows = tmuxRows(600);
    await reseed(tailCapture(rows, 300));
    const converge = async (revision: number) => {
      for (let n = 0; n < 200; n++) {
        await settle();
        partial.drain();
        full.drain();
        if (partial.state.appliedRevision === revision && full.state.appliedRevision === revision)
          return;
      }
      throw new Error(`clients did not reach revision ${revision}`);
    };
    await converge(interpreter.currentSeed()!.revision);
    expect(await i.prependNativeHistory(piece(rows, 0, 300, 600))).toBe(true);
    const seed = interpreter.currentSeed()!;
    await converge(seed.revision);
    expect(full.state.canonicalSnapshot).toEqual(seed.snapshot);
    expect(full.state.appliedHash).toBe(seed.stateHash);
    expect(partial.state.appliedHash).toBe(seed.stateHash);
    // The partial client holds a 200-row tail; the rows prepended are unloaded.
    expect(partial.envelopes.at(-1)).toMatchObject({ frame: "seed", history: "partial" });
    expect(partial.state.historyUnloaded?.rows).toBe(400);
    await hub.close();
  });
});

type Timer = { task: () => void; delayMs: number; cancelled: boolean };

/** An owner on a fake mirror whose native seeds leave out the oldest rows. */
async function ownerRig(
  options: {
    historyRows?: number;
    omitted?: number;
    cols?: number;
    accept?: boolean;
    historyRowCap?: number;
  } = {},
) {
  const cols = options.cols ?? COLS;
  const historyRows = options.historyRows ?? 15;
  let tmux = tmuxRows(historyRows, [], cols);
  let request!: MirrorSubscribeRequest;
  const timers: Timer[] = [];
  const requests: NativeHistoryRequest[] = [];
  let accept = options.accept ?? true;
  const requestNativeHistory = vi.fn((r: NativeHistoryRequest) => {
    if (!accept) return false;
    requests.push(r);
    return true;
  });
  const reseedCalls = vi.fn();
  const captureNativeBacking = vi.fn(async () => ({
    status: "captured" as const,
    isCurrent: () => true,
    // The rows the replica holds: a comparison would wrongly pass.
    snapshot: tailCapture(tmux, options.omitted ?? 10, 2000, cols),
  }));
  let historySize = historyRows;
  const readHistorySize = vi.fn(async () => historySize);
  const seed = (omitted: number, layoutCols = cols) => {
    request.onLayout?.(layoutFor(layoutCols));
    request.onEvent({ type: "reset", cols: layoutCols, rows: ROWS });
    request.onEvent({
      type: "seed",
      native: tailCapture(tmux, omitted, 2000, layoutCols),
      data: new Uint8Array(),
    });
    request.onEvent({
      type: "cursor",
      x: 0,
      y: ROWS - 1,
      historyLimit: 2000,
      historySize: tmux.length - ROWS,
    });
  };
  const mirror = {
    subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
      request = candidate;
      queueMicrotask(() => seed(options.omitted ?? 10));
      return {
        session: candidate.session,
        semanticPaneId: candidate.semanticPaneId,
        freeze: () => undefined,
        thaw: () => undefined,
        reseed: reseedCalls,
        sendText: () => undefined,
        sendKey: () => undefined,
        close: async () => undefined,
        requestNativeHistory,
        captureNativeBacking,
        readHistorySize,
      } as MirrorSubscription;
    },
  };
  const owner = new SessionRuntimeTerminalReplicaOwner(generation, "w", "pane", mirror as never, {
    incarnation: `${generation}:0`,
    initialRevision: 0,
    ...(options.historyRowCap !== undefined ? { historyRowCap: options.historyRowCap } : {}),
    scheduler: {
      nowMs: () => performance.now(),
      createId: () => "id",
      microtask: (task) => queueMicrotask(task),
      timer: (task, delayMs) => {
        const timer = { task, delayMs, cancelled: false };
        timers.push(timer);
        return { cancel: () => (timer.cancelled = true) };
      },
    },
  });
  const subscription = await owner.subscribe(() => undefined);
  const live = () => timers.filter((t) => !t.cancelled);
  return {
    owner,
    subscription,
    requests,
    requestNativeHistory,
    reseedCalls,
    captureNativeBacking,
    readHistorySize,
    timers: live,
    setAccept: (value: boolean) => (accept = value),
    setHistorySize: (value: number) => (historySize = value),
    get tmux() {
      return tmux;
    },
    setTmux: (rows: NativeGridCaptureRow[]) => (tmux = rows),
    seed,
    event: (event: MirrorPaneEvent) => request.onEvent(event),
    layout: (layoutCols: number) => request.onLayout?.(layoutFor(layoutCols)),
    /** Answer the oldest request with the rows tmux holds now. */
    answer(r: NativeHistoryRequest) {
      const count = Math.min(r.rows, r.endRow);
      request.onEvent({
        type: "history",
        piece: piece(tmux, r.endRow - count, count, tmux.length - ROWS, cols),
      });
    },
    /** Run the timers of one delay that are due now. */
    fire(delayMs?: number) {
      for (const timer of live().filter((t) => delayMs === undefined || t.delayMs === delayMs)) {
        timer.cancelled = true;
        timer.task();
      }
    },
  };
}

function layoutFor(width: number) {
  return {
    type: "layout" as const,
    session: "w",
    semanticWindowId: "window",
    windowName: "main",
    currentWindow: true,
    cols: width,
    rows: ROWS,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [{ semanticPaneId: "pane", left: 0, top: 0, width, height: ROWS, active: true }],
  };
}

const flush = async () => {
  for (let n = 0; n < 10; n++) await new Promise<void>((r) => setImmediate(r));
};

describe("owner: the backfill (#873 point 3)", () => {
  it("asks for the rows below its oldest one until it holds tmux's whole history", async () => {
    const r = await ownerRig({ historyRows: 15, omitted: 10 });
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      expect(r.requests[0]).toEqual({
        endRow: 10,
        // One piece, or the room left under the cap if that is less.
        rows: Math.min(nativeHistoryPieceRows(COLS), DAEMON_HISTORY_ROW_CAP - 5),
        historySize: 15,
      });
      r.answer(r.requests[0]!);
      await flush();
      expect(r.requests).toHaveLength(1);
      const seen: CanonicalTerminalReplicaUpdate[] = [];
      await r.owner.subscribe((u) => seen.push(u));
      const snapshot = seen[0]!.type === "terminal.seed" ? seen[0]!.snapshot : null;
      expect(snapshot!.history.map(text)).toEqual(Array.from({ length: 15 }, (_, n) => `R${n}`));
    } finally {
      await r.owner.dispose();
    }
  });

  it("asks piece by piece when the rows left out exceed one piece", async () => {
    const cols = 4096; // 64 rows per piece
    const per = nativeHistoryPieceRows(cols);
    const r = await ownerRig({ historyRows: 200, omitted: 150, cols });
    try {
      const ends: number[] = [];
      for (let step = 0; step < 3; step++) {
        await vi.waitFor(() => expect(r.requests).toHaveLength(step + 1));
        const q = r.requests[step]!;
        ends.push(q.endRow);
        expect(q.historySize).toBe(200);
        expect(q.rows).toBe(per);
        r.answer(q);
      }
      expect(ends).toEqual([150, 150 - per, 150 - 2 * per]);
      await flush();
      expect(r.requests).toHaveLength(3);
      const seen: CanonicalTerminalReplicaUpdate[] = [];
      await r.owner.subscribe((u) => seen.push(u));
      const snapshot = seen[0]!.type === "terminal.seed" ? seen[0]!.snapshot : null;
      expect(snapshot!.history).toHaveLength(200);
      expect(text(snapshot!.history[0]!)).toBe("R0");
    } finally {
      await r.owner.dispose();
    }
  });

  it("asks again after a null answer, backing off, and stops after a run of failures", async () => {
    const r = await ownerRig();
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      const delays: number[] = [];
      for (let n = 0; n < 40; n++) {
        const asked = r.requests.length;
        r.event({ type: "history", piece: null });
        await flush();
        const timer = r.timers()[0];
        if (!timer) break;
        delays.push(timer.delayMs);
        r.fire(timer.delayMs);
        await vi.waitFor(() => expect(r.requests.length).toBe(asked + 1));
      }
      // 250 ms doubling to 4 s; the 16th failure in a row stops it.
      expect(delays).toEqual([250, 500, 1000, 2000, ...Array.from({ length: 11 }, () => 4000)]);
      expect(BACKFILL_MAX_FAILURES).toBe(16);
      const asked = r.requests.length;
      r.event({ type: "history", piece: null });
      await flush();
      expect(r.timers()).toHaveLength(0);
      // The next reseed starts over.
      r.seed(10);
      await vi.waitFor(() => expect(r.requests.length).toBe(asked + 1));
    } finally {
      await r.owner.dispose();
    }
  });

  it("asks again later when the request was not sent", async () => {
    const r = await ownerRig({ accept: false });
    try {
      await vi.waitFor(() => expect(r.requestNativeHistory).toHaveBeenCalledTimes(1));
      expect(r.requests).toHaveLength(0);
      await flush();
      expect(r.timers().map((t) => t.delayMs)).toEqual([250]);
      r.setAccept(true);
      r.fire(250);
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
    } finally {
      await r.owner.dispose();
    }
  });

  it("asks again after a piece the replica refused", async () => {
    const r = await ownerRig();
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      // tmux's history size moved: the piece does not fit.
      r.event({ type: "history", piece: piece(r.tmux, 0, 10, 16) });
      await flush();
      expect(r.timers().map((t) => t.delayMs)).toContain(250);
      r.fire(250);
      await vi.waitFor(() => expect(r.requests).toHaveLength(2));
    } finally {
      await r.owner.dispose();
    }
  });

  it("ignores an answer that arrives while a reseed is capturing", async () => {
    const r = await ownerRig();
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      await r.owner.subscribe((u) => updates.push(u));
      const before = updates.length;
      r.event({ type: "reset", cols: COLS, rows: ROWS });
      r.answer(r.requests[0]!);
      await flush();
      expect(updates).toHaveLength(before);
    } finally {
      await r.owner.dispose();
    }
  });

  it("counts failures in a row: a prepended piece starts the count again", async () => {
    const cols = 4096; // 64 rows per piece
    const r = await ownerRig({ historyRows: 200, omitted: 150, cols });
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      const fail = async () => {
        const asked = r.requests.length;
        r.event({ type: "history", piece: null });
        await flush();
        r.fire();
        await vi.waitFor(() => expect(r.requests.length).toBe(asked + 1));
      };
      for (let n = 0; n < 15; n++) await fail();
      r.answer(r.requests.at(-1)!);
      await vi.waitFor(() => expect(r.requests.length).toBe(17));
      r.event({ type: "history", piece: null });
      await flush();
      expect(r.timers().map((t) => t.delayMs)).toEqual([250]);
    } finally {
      await r.owner.dispose();
    }
  });

  it("ignores an answer to a request made before a reseed", async () => {
    const r = await ownerRig();
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      const old = r.requests[0]!;
      r.seed(10);
      await vi.waitFor(() => expect(r.requests).toHaveLength(2));
      // The old answer arrives first; it would fit, but it belongs to the old seed.
      const prepends: CanonicalTerminalReplicaUpdate[] = [];
      await r.owner.subscribe((u) => prepends.push(u));
      const before = prepends.length;
      r.answer(old);
      await flush();
      expect(prepends).toHaveLength(before);
      expect(r.timers().filter((t) => t.delayMs === 250)).toHaveLength(0);
      r.answer(r.requests[1]!);
      await vi.waitFor(() => expect(prepends.length).toBeGreaterThan(before));
    } finally {
      await r.owner.dispose();
    }
  });

  it("waits while the alternate screen is active", async () => {
    const r = await ownerRig();
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      r.event({ type: "delta", data: new TextEncoder().encode("\x1b[?1049h") });
      r.event({ type: "history", piece: null });
      await flush();
      r.fire(250);
      await vi.waitFor(() =>
        expect(r.timers().map((t) => t.delayMs)).toContain(BACKFILL_ALTERNATE_WAIT_MS),
      );
      expect(r.requests).toHaveLength(1);
      r.event({ type: "delta", data: new TextEncoder().encode("\x1b[?1049l") });
      await flush();
      r.fire();
      await vi.waitFor(() => expect(r.requests).toHaveLength(2));
    } finally {
      await r.owner.dispose();
    }
  });

  it.each(["resize", "park", "dispose"] as const)("drops its state on %s", async (change) => {
    const r = await ownerRig();
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      r.event({ type: "history", piece: null });
      await flush();
      expect(r.timers().some((t) => t.delayMs === 250)).toBe(true);
      if (change === "resize") r.layout(COLS + 1);
      if (change === "park") {
        await r.subscription.close();
        r.fire(PARK_AFTER_MS);
      }
      if (change === "dispose") await r.owner.dispose();
      expect(r.timers().filter((t) => t.delayMs === 250)).toHaveLength(0);
      r.fire();
      await flush();
      expect(r.requests).toHaveLength(1);
    } finally {
      await r.owner.dispose();
    }
  });
});

describe("owner: history size and native backing with rows left out (#873 point 4)", () => {
  it("accepts tmux's history size when it is the held rows plus the rows left out", async () => {
    const r = await ownerRig();
    try {
      r.setAccept(false);
      r.setHistorySize(15);
      r.event({ type: "delta", data: new TextEncoder().encode("") });
      r.fire(250);
      await vi.waitFor(() => expect(r.readHistorySize).toHaveBeenCalled());
      await flush();
      expect(r.reseedCalls).not.toHaveBeenCalled();
      // A real difference still reseeds.
      r.setHistorySize(16);
      r.event({ type: "delta", data: new TextEncoder().encode("") });
      r.fire(250);
      await vi.waitFor(() => expect(r.reseedCalls).toHaveBeenCalledOnce());
    } finally {
      await r.owner.dispose();
    }
  });

  it("does not compare native backing rows against a history with rows left out", async () => {
    const r = await ownerRig();
    try {
      const result = await r.owner.captureNativeBacking();
      expect(result.status).toBe("mismatch");
      expect(r.captureNativeBacking).not.toHaveBeenCalled();
    } finally {
      await r.owner.dispose();
    }
  });
});

describe("the daemon's cap on rows held per pane (#873, owner decision of 25 Nov)", () => {
  const held = (backend: TerminalInterpreterBackend) => project(backend).history;

  it("holds 10,000 history rows unless told otherwise", () => {
    expect(DAEMON_HISTORY_ROW_CAP).toBe(10_000);
    const backend = createXtermTerminalInterpreterBackend({ cols: 4, rows: 2, scrollback: 100 });
    expect(backend.historyRowCap?.()).toBe(10_000);
  });

  it("keeps the newest rows of a seed over the cap and counts the rest as left out", () => {
    const rows = tmuxRows(15);
    const backend = seededBackend(tailCapture(rows, 0), 2000, 10);
    expect(held(backend).map(text)).toEqual(Array.from({ length: 10 }, (_, n) => `R${n + 5}`));
    expect(backend.omittedHistory()).toBe(5);
  });

  it("moves rows that live output pushes past the cap to the rows left out", async () => {
    const backend = seededBackend(tailCapture(tmuxRows(15), 0), 2000, 10);
    await backend.write(lines(0, 3));
    const history = held(backend);
    expect(history).toHaveLength(10);
    expect(backend.omittedHistory()).toBe(8);
    expect(text(history[0]!)).toBe("R8");
  });

  it("still collects at tmux's limit as tmux does, counting rows past the cap", async () => {
    // tmux: 15 rows, limit 20; ten more lines leave it 19 (it drops 2 at 20).
    const backend = seededBackend(tailCapture(tmuxRows(15), 0), 20, 10);
    for (let n = 0; n < 10; n++) await backend.write(lines(n, 1));
    const history = held(backend);
    expect(history).toHaveLength(10);
    expect(backend.omittedHistory() + history.length).toBe(19);
  });

  it("keeps a prepended piece within the cap", () => {
    const rows = tmuxRows(15);
    const backend = seededBackend(tailCapture(rows, 10), 2000, 10);
    expect(backend.prependNativeHistory(piece(rows, 0, 10, 15))).toBe(true);
    expect(held(backend).map(text)).toEqual(Array.from({ length: 10 }, (_, n) => `R${n + 5}`));
    expect(backend.omittedHistory()).toBe(5);
  });

  it("trims a seed over the cap in the owner's replica and asks for nothing", async () => {
    const r = await ownerRig({ historyRows: 30, omitted: 15, historyRowCap: 10 });
    try {
      const seen: CanonicalTerminalReplicaUpdate[] = [];
      await r.owner.subscribe((u) => seen.push(u));
      const snapshot = seen[0]!.type === "terminal.seed" ? seen[0]!.snapshot : null;
      expect(snapshot!.history.map(text)).toEqual(
        Array.from({ length: 10 }, (_, n) => `R${n + 20}`),
      );
      await flush();
      expect(r.requests).toHaveLength(0);
    } finally {
      await r.owner.dispose();
    }
  });

  it("publishes a scroll at the cap as a one-row history delta, not the whole history", async () => {
    const { interpreter, updates, reseed } = interpreterRig(undefined, 10);
    await reseed(tailCapture(tmuxRows(15), 0));
    await interpreter.whenIdle();
    expect(interpreter.currentSeed()!.snapshot.history).toHaveLength(10);
    updates.length = 0;
    for (let n = 0; n < 5; n++) {
      interpreter.enqueue({ type: "write", data: new TextEncoder().encode(lines(n, 1)) });
      await interpreter.whenIdle();
    }
    const patches = updates.filter((u) => u.type === "terminal.patch");
    expect(patches.length).toBeGreaterThanOrEqual(5);
    for (const update of patches) {
      if (update.type !== "terminal.patch") continue;
      expect(update.patch.history).toBeUndefined();
      expect(update.patch.historyDelta).toMatchObject({ trim: 1 });
      expect(update.patch.historyDelta!.append).toHaveLength(1);
    }
    expect(interpreter.currentSeed()!.snapshot.history).toHaveLength(10);
    expect(interpreter.omittedHistory()).toBe(10);
  });

  it("asks only up to the cap, then never again, and its history check agrees with tmux", async () => {
    const r = await ownerRig({ historyRows: 30, omitted: 25, historyRowCap: 10 });
    try {
      await vi.waitFor(() => expect(r.requests).toHaveLength(1));
      expect(r.requests[0]).toEqual({ endRow: 25, rows: 5, historySize: 30 });
      r.answer(r.requests[0]!);
      await flush();
      for (const delay of [250, 500, 1000, 4000]) r.fire(delay);
      await flush();
      expect(r.requests).toHaveLength(1);
      const seen: CanonicalTerminalReplicaUpdate[] = [];
      await r.owner.subscribe((u) => seen.push(u));
      const snapshot = seen[0]!.type === "terminal.seed" ? seen[0]!.snapshot : null;
      expect(snapshot!.history.map(text)).toEqual(
        Array.from({ length: 10 }, (_, n) => `R${n + 20}`),
      );
      // tmux still holds 30: the 20 rows past the cap are left out, not missing.
      r.setHistorySize(30);
      r.event({ type: "delta", data: new TextEncoder().encode("") });
      r.fire(250);
      await vi.waitFor(() => expect(r.readHistorySize).toHaveBeenCalled());
      await flush();
      expect(r.reseedCalls).not.toHaveBeenCalled();
      expect(r.requests).toHaveLength(1);
    } finally {
      await r.owner.dispose();
    }
  });
});
