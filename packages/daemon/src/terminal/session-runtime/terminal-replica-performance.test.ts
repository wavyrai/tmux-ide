import { describe, expect, it } from "vitest";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";

const generation = "00000000-0000-4000-8000-000000000001";

function interpreter(updates: CanonicalTerminalReplicaUpdate[], scrollback = 5000) {
  return new TerminalReplicaInterpreter({
    generation,
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    incarnation: `${generation}:0`,
    cols: 80,
    rows: 24,
    scrollback,
    onUpdate: (update) => updates.push(update),
  });
}

describe("terminal replica performance invariants", () => {
  it("coalesces 10k same-turn chunks into one parse and one dirty row", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const replica = interpreter(updates);
    await Promise.all(
      Array.from({ length: 10_000 }, () =>
        replica.enqueue({ type: "write", data: new TextEncoder().encode("x\b") }),
      ),
    );
    expect(replica.stats()).toMatchObject({
      parseBatches: 1,
      fullWalks: 0,
      historyRowsRead: 0,
      placementRowsRead: 0,
      historyKeyVisits: 0,
    });
    expect(replica.stats().gridRowsRead).toBeLessThanOrEqual(1);
    expect(updates).toHaveLength(1);
  });

  it("does zero parser/projection work while idle", async () => {
    const replica = interpreter([]);
    await replica.enqueue({ type: "write", data: new TextEncoder().encode("ready") });
    const before = replica.stats();
    for (let index = 0; index < 10_000; index += 1) replica.currentSnapshot();
    await replica.whenIdle();
    expect(replica.stats()).toEqual(before);
  });

  it("rotates capped history by reading only newly exposed rows", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const replica = interpreter(updates, 20);
    await replica.enqueue({
      type: "reseed",
      cols: 80,
      rows: 3,
      chunks: [
        new TextEncoder().encode(
          Array.from({ length: 23 }, (_, index) => `line-${index}`).join("\r\n"),
        ),
      ],
      cursor: { x: 7, y: 2 },
      bootstrap: "authoritative-stream",
    });
    const before = replica.stats();
    const firstBefore = replica.currentSnapshot().history[0];
    await replica.enqueue({ type: "write", data: new TextEncoder().encode("\r\nnew") });
    const after = replica.stats();
    expect(replica.currentSnapshot().history[0]).not.toBe(firstBefore);
    expect(after.historyRowsRead - before.historyRowsRead).toBeLessThanOrEqual(1);
    expect(updates.at(-1)?.type).toBe("terminal.patch");
    if (updates.at(-1)?.type === "terminal.patch") {
      expect(updates.at(-1)?.patch.historyDelta).toMatchObject({ trim: 1 });
      expect(updates.at(-1)?.patch.history).toBeUndefined();
    }
  });

  it("projects only appended rows when ED2 collects ten percent of history", async () => {
    for (const clears of [1, 3]) {
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const replica = interpreter(updates, 20);
      await replica.enqueue({
        type: "reseed",
        cols: 80,
        rows: 3,
        historyLimit: 20,
        chunks: [
          new TextEncoder().encode(Array.from({ length: 23 }, (_, i) => `line-${i}`).join("\r\n")),
        ],
        cursor: { x: 0, y: 0 },
        observedModes: { scrollOnClear: true },
        bootstrap: "authoritative-stream",
      });
      // Erase visible rows without pushing them into history, leaving one used row.
      await replica.enqueue({
        type: "write",
        data: new TextEncoder().encode("\x1b[H\x1b[Jinitial"),
      });
      const previous = replica.currentSnapshot();
      const before = replica.stats();
      await replica.enqueue({
        type: "write",
        data: new TextEncoder().encode("\x1b[2J\x1b[Hnext".repeat(clears)),
      });
      const next = replica.currentSnapshot();
      const expectedTrim = clears === 1 ? 2 : 4;
      expect(next.history).toHaveLength(20 - expectedTrim + clears);
      expect(next.history[0]).toBe(previous.history[expectedTrim]);
      expect(replica.stats().historyRowsRead - before.historyRowsRead).toBe(clears);
      const update = updates.at(-1);
      expect(update?.type).toBe("terminal.patch");
      if (update?.type === "terminal.patch") {
        expect(update.patch.history).toBeUndefined();
        expect(update.patch.historyDelta?.trim).toBe(expectedTrim);
        expect(update.patch.historyDelta?.append).toHaveLength(clears);
      }
    }
  });

  it("bounds projection reads at a 2000-row native history cap", async () => {
    const replica = interpreter([], 2000);
    await replica.enqueue({
      type: "reseed",
      cols: 80,
      rows: 3,
      historyLimit: 2000,
      chunks: [
        new TextEncoder().encode(Array.from({ length: 2003 }, (_, i) => `line-${i}`).join("\r\n")),
      ],
      cursor: { x: 0, y: 0 },
      observedModes: { scrollOnClear: true },
      bootstrap: "authoritative-stream",
    });
    await replica.enqueue({ type: "write", data: new TextEncoder().encode("\x1b[H\x1b[Jinitial") });
    const previous = replica.currentSnapshot();
    const before = replica.stats();
    await replica.enqueue({ type: "write", data: new TextEncoder().encode("\x1b[2J\x1b[Hnext") });
    const after = replica.stats();
    expect(replica.currentSnapshot().history).toHaveLength(1801);
    expect({
      historyRowsRead: after.historyRowsRead - before.historyRowsRead,
      gridRowsRead: after.gridRowsRead - before.gridRowsRead,
      cellsRead: after.cellsRead - before.cellsRead,
    }).toEqual({ historyRowsRead: 1, gridRowsRead: 3, cellsRead: 320 });
    expect(replica.currentSnapshot().history[0]).toBe(previous.history[200]);
  });

  it("does not interpret history clearing, reset, or alternate trips as incremental scrolls", async () => {
    for (const control of ["\x1b[3J", "\x1bc", "\x1b[?1049halt\n\x1b[?1049l"]) {
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const replica = interpreter(updates, 20);
      await replica.enqueue({
        type: "reseed",
        cols: 80,
        rows: 3,
        historyLimit: 20,
        chunks: [
          new TextEncoder().encode(Array.from({ length: 23 }, (_, i) => `line-${i}`).join("\r\n")),
        ],
        cursor: { x: 0, y: 0 },
        observedModes: { scrollOnClear: true },
        bootstrap: "authoritative-stream",
      });
      await replica.enqueue({
        type: "write",
        data: new TextEncoder().encode(control + "\x1b[H\x1b[Jfresh\x1b[2J"),
      });
      const update = updates.at(-1);
      expect(update?.type).toBe("terminal.patch");
      if (update?.type === "terminal.patch") expect(update.patch.historyDelta).toBeUndefined();
      const history = replica.currentSnapshot().history;
      expect(
        history
          .at(-1)
          ?.cells.map((cell) => cell.grapheme)
          .join("")
          .trim(),
      ).toBe("fresh");
      if (control !== "\x1b[?1049halt\n\x1b[?1049l") expect(history).toHaveLength(1);
    }
  });

  it("releases canonical scrollback authority when the terminal clears history", async () => {
    const replica = interpreter([]);
    await replica.enqueue({
      type: "write",
      data: new TextEncoder().encode(
        Array.from({ length: 300 }, (_, index) => `load-${index}`).join("\r\n"),
      ),
    });
    expect(replica.currentSnapshot().history.length).toBeGreaterThan(0);

    await replica.enqueue({
      type: "write",
      data: new TextEncoder().encode("\u001b[2J\u001b[3J\u001b[Hsettled"),
    });

    const settled = replica.currentSnapshot();
    expect(settled.history).toHaveLength(0);
    expect(
      settled.grid[0]?.cells
        .map(({ grapheme }) => grapheme)
        .join("")
        .startsWith("settled"),
    ).toBe(true);
  });

  it("never leaks a resize or byte frame while DEC synchronized-output is open", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const replica = interpreter(updates);
    await replica.enqueue({ type: "write", data: new TextEncoder().encode("\u001b[?2026h") });
    const flood = new TextEncoder().encode("A\b".repeat(550_000));
    await replica.enqueue({ type: "write", data: flood });
    await replica.enqueue({ type: "resize", cols: 100, rows: 30 });
    expect(updates).toHaveLength(0);
    await replica.enqueue({ type: "write", data: new TextEncoder().encode("\u001b[?2026l") });
    expect(updates).toHaveLength(1);
    expect(replica.currentSnapshot()).toMatchObject({ cols: 100, rows: 30 });
  }, 20_000);

  it("recovers an unterminated synchronized-output block without permanent staleness", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const replica = interpreter(updates);
    await replica.enqueue({
      type: "write",
      data: new TextEncoder().encode("\u001b[?2026hwaiting"),
    });
    await replica.enqueue({ type: "resize", cols: 100, rows: 30 });
    expect(updates).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 325));
    await replica.whenIdle();
    expect(updates).toHaveLength(1);
    expect(replica.currentSnapshot()).toMatchObject({ cols: 100, rows: 30 });
    expect(replica.currentSnapshot().modes.synchronizedOutput).toBe(false);
  });
});
