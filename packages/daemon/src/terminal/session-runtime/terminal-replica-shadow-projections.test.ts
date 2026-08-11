import { describe, expect, it } from "vitest";
import {
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  type TerminalReplicaState,
} from "@tmux-ide/core";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import { PaneMirror } from "../../tui/mirror/pane-mirror.ts";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import {
  projectTerminalReplicaForOpenTui,
  projectTerminalReplicaForWeb,
} from "./terminal-replica-shadow-projections.ts";

describe("terminal replica shadow projections", () => {
  it("projects one equal revision/hash without reparsing and themes defaults only", () => {
    const snapshot = blankTerminalReplicaSnapshot(2, 1);
    const web = projectTerminalReplicaForWeb(snapshot);
    const tui = projectTerminalReplicaForOpenTui(snapshot, {
      foreground: 0xeeeeee,
      background: 0x111111,
    });
    expect(web[0]![0]!.foreground).toEqual({ kind: "default" });
    expect(tui[0]![0]).toMatchObject({ fg: 0xeeeeee, bg: 0x111111 });
    expect(hashTerminalReplicaSnapshot(snapshot)).toMatch(/^[0-9a-f]{16}$/u);
  });

  it.each([
    ["flood", Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\r\n")],
    ["alternate-screen", "normal\u001b[?1049hALT\u001b[?1049l"],
    ["history-clear", "one\r\ntwo\r\nthree\u001b[3Jafter"],
    ["split-utf8-csi", "界e\u0301\u001b[38;2;10;20;30mRGB\u001b[0m"],
  ])("matches legacy PaneMirror in shadow for %s", async (_name, text) => {
    const cols = 32;
    const rows = 6;
    const mirror = new PaneMirror(cols, rows);
    mirror.write(new TextEncoder().encode(text));
    await waitForMirror(
      mirror,
      text.includes("after")
        ? "after"
        : text.includes("line-")
          ? "line-79"
          : text.includes("RGB")
            ? "RGB"
            : "normal",
    );
    const legacy = mirror.snapshot();
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000001",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      cols,
      rows,
      onUpdate: (update) => updates.push(update),
    });
    const bytes = new TextEncoder().encode(text);
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    await interpreter.enqueue({
      type: "reseed",
      cols,
      rows,
      chunks,
      cursor: { x: legacy.cursorX, y: legacy.cursorY },
      bootstrap: "authoritative-stream",
    });
    expect(canonicalText(interpreter.currentSnapshot())).toEqual(
      legacy.rows.map((row) => row.map((run) => run.text).join("")),
    );
    expect(interpreter.currentSnapshot().cursor).toMatchObject({
      x: legacy.cursorX,
      y: legacy.cursorY,
    });
    expect(updates).toHaveLength(1);
    mirror.dispose();
  });

  it("keeps partial CSI/UTF-8 ordered across an intervening resize", async () => {
    const interpreter = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000001",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      cols: 12,
      rows: 3,
    });
    await interpreter.enqueue({ type: "write", data: Uint8Array.of(0xe7, 0x95) });
    await interpreter.enqueue({ type: "resize", cols: 10, rows: 2 });
    await interpreter.enqueue({ type: "write", data: Uint8Array.of(0x8c, 0x1b, 0x5b, 0x33, 0x31) });
    await interpreter.enqueue({ type: "write", data: new TextEncoder().encode("mR") });
    expect(interpreter.currentSnapshot().grid[0]!.cells[0]).toMatchObject({
      grapheme: "界",
      width: 2,
    });
    expect(interpreter.currentSnapshot().grid[0]!.cells[2]!.foreground).toEqual({
      kind: "indexed",
      index: 1,
    });
    expect(interpreter.currentSnapshot()).toMatchObject({ cols: 10, rows: 2 });
  });

  it("matches legacy output stepwise and reconstructs every incremental frame", async () => {
    const mirror = new PaneMirror(12, 3, 20);
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000001",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      cols: 12,
      rows: 3,
      scrollback: 20,
      onUpdate: (update) => updates.push(update),
    });
    let replay: TerminalReplicaState | null = null;
    const steps = [
      "\u001b[31mred\u001b[0m",
      "\r\nwide界e\u0301",
      "\r\none\r\ntwo\r\nthree",
      "\u001b[?1049hALT\u001b[?1049l",
      "\u001b[2J\u001b[Hfinal",
    ];
    for (const text of steps) {
      const parsed = new Promise<void>((resolve) => {
        mirror.onParsed = resolve;
      });
      mirror.write(new TextEncoder().encode(text));
      await interpreter.enqueue({ type: "write", data: new TextEncoder().encode(text) });
      await parsed;
      while ((replay?.revision ?? -1) < (updates.at(-1)?.revision ?? -1)) {
        const update = updates[(replay?.revision ?? -1) + 1]!;
        const result = applyTerminalReplicaUpdate(replay, update);
        expect(result.status).toBe("applied");
        replay = result.state;
      }
      expect(canonicalBufferText(interpreter.currentSnapshot())).toEqual(mirror.bufferLines());
      expect(replay?.snapshot).toEqual(interpreter.currentSnapshot());
    }
    mirror.resize(9, 4);
    await interpreter.enqueue({ type: "resize", cols: 9, rows: 4 });
    expect(canonicalBufferText(interpreter.currentSnapshot())).toEqual(mirror.bufferLines());
    mirror.dispose();
  });
});

async function waitForMirror(mirror: PaneMirror, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mirror.bufferLines().some((line) => line.includes(needle))) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function canonicalText(
  snapshot: ReturnType<TerminalReplicaInterpreter["currentSnapshot"]>,
): string[] {
  return snapshot.grid.map((row) =>
    row.cells
      .filter((cell) => cell.width !== 0)
      .map((cell) => cell.grapheme)
      .join(""),
  );
}

function canonicalBufferText(
  snapshot: ReturnType<TerminalReplicaInterpreter["currentSnapshot"]>,
): string[] {
  return [...snapshot.history, ...snapshot.grid].map((row) =>
    row.cells
      .filter((cell) => cell.width !== 0)
      .map((cell) => cell.grapheme)
      .join("")
      .trimEnd(),
  );
}
