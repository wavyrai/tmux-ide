import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { expect, it, vi } from "vitest";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";

// The native tmux this replica must agree with (the bundled, patched build).
const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
const LIMIT = 50;
const COLS = 20;
const ROWS = 4;

/**
 * Scroll past the history-limit in real tmux and in the replica with the same
 * output: history size and every history row must match. tmux collects a
 * tenth at its limit; a replica that drifted from that was reseeded whole by
 * the owner's history-size check.
 */
it.skipIf(!binary).each([30, 57, 120, 333])(
  "keeps replica history equal to native tmux after %i lines at limit 50",
  async (count) => {
    expect(isAbsolute(binary!)).toBe(true);
    const socket = `zz-history-${process.pid}-${randomUUID().slice(0, 8)}`;
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TMUX: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    const replica = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000001",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      cols: COLS,
      rows: ROWS,
      scrollback: LIMIT,
    });
    try {
      run("new-session", "-d", "-s", "h", "-x", String(COLS), "-y", String(ROWS), "sleep 60");
      run("set-option", "-g", "history-limit", String(LIMIT));
      const pane = run(
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        `stty -echo; seq 1 ${count}; printf DONE; sleep 60`,
      );
      await vi.waitFor(() =>
        expect(run("capture-pane", "-p", "-t", pane).split("\n").at(-1)).toBe("DONE"),
      );
      const tmuxHistory = Number(run("display-message", "-p", "-t", pane, "#{history_size}"));
      const all = run("capture-pane", "-p", "-t", pane, "-S", "-", "-E", "-").split("\n");
      const tmuxRows = all.slice(0, tmuxHistory);
      await replica.enqueue({
        type: "write",
        data: new TextEncoder().encode(
          Array.from({ length: count }, (_, i) => `${i + 1}\r\n`).join("") + "DONE",
        ),
      });
      await replica.whenIdle();
      const history = replica.currentSnapshot().history.map((row) =>
        row.cells
          .map((cell) => cell.grapheme)
          .join("")
          .trimEnd(),
      );
      expect(history).toHaveLength(tmuxHistory);
      expect(history).toEqual(tmuxRows);
    } finally {
      await replica.enqueue({ type: "close", reason: "runtime-disposed" });
      try {
        run("kill-server");
      } catch {
        // Already gone.
      }
    }
  },
);
