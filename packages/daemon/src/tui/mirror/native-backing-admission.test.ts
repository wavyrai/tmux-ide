import { describe, expect, it } from "vitest";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import { decodeNativeGridCapture } from "../../terminal/mirror/native-grid-capture.ts";
import { projectNativeGridRow } from "../../terminal/mirror/native-grid-projection.ts";
import { retainNativeTerminalBacking } from "./terminal-viewport.ts";

describe("native reflow backing admission", () => {
  it("rejects lossy version-one backing even when its visible projection matches", () => {
    const backing = decodeNativeGridCapture(
      JSON.stringify({
        version: 1,
        cols: 2,
        rows: 1,
        history: 0,
        hscrolled: 0,
        limit: 100,
        cursor: [0, 0],
      }) +
        "\n" +
        JSON.stringify({ row: 0, flags: 0, used: 0, cells: [] }) +
        "\n",
    );
    expect(backing).not.toBeNull();
    expect(retainNativeTerminalBacking(blankTerminalReplicaSnapshot(2, 1), backing!)).toBe(false);
  });

  it("admits matching version-two erased cells while retaining the used-text boundary", () => {
    const backing = decodeNativeGridCapture(
      JSON.stringify({
        version: 2,
        cols: 2,
        rows: 1,
        history: 0,
        hscrolled: 0,
        limit: 100,
        cursor: [0, 0],
      }) +
        "\n" +
        JSON.stringify({
          row: 0,
          flags: 0,
          used: 0,
          cells: Array.from({ length: 2 }, () => [0, 1, "20", 0, 8, 0x01000011, 8, 0, 0]),
        }) +
        "\n",
    );
    expect(backing).not.toBeNull();
    const snapshot = {
      ...blankTerminalReplicaSnapshot(2, 1),
      grid: [projectNativeGridRow(backing!.grid[0], 2)!],
    };
    expect(backing!.grid[0]!.used).toBe(0);
    expect(backing!.grid[0]!.cells).toHaveLength(2);
    expect(retainNativeTerminalBacking(snapshot, backing!)).toBe(true);
    expect(retainNativeTerminalBacking(blankTerminalReplicaSnapshot(2, 1), backing!)).toBe(false);
  });
});
