import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { applyTerminalReplicaUpdate } from "@tmux-ide/core";
import { MirrorControlChannel } from "../mirror/control-channel.ts";
import { MirrorService } from "../mirror/mirror-service.ts";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import { SessionRuntimeTerminalReplicaOwner } from "./terminal-replica-owner.ts";

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

/**
 * A `clear` at the history-limit with more rows than a tenth of it: tmux's
 * ED2 collection and the replica's can leave different rows. The history-size
 * check must catch that and reseed, so the replica ends equal to tmux. A
 * size-only repair (trimming the replica's oldest rows) once hid this case
 * with wrong rows (#430 review: replica r55…r68 against tmux r66…r79).
 */
it.skipIf(!binary)("ends equal to native tmux after a clear at the history-limit", async () => {
  expect(isAbsolute(binary!)).toBe(true);
  const socket = `zz-history-clear-${process.pid}-${randomUUID().slice(0, 8)}`;
  const directory = mkdtempSync(join(tmpdir(), "history-clear-"));
  const run = (...args: string[]) =>
    execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, TMUX: "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const rows = (tag: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${tag}${i}\r\n`).join("");
  const input = join(directory, "input");
  writeFileSync(input, rows("r", 80) + "\x1b[H\x1b[2J" + rows("s", 25));
  const mirror = new MirrorService({
    createIo: (name, handlers) =>
      new MirrorControlChannel({
        session: name,
        handlers,
        socketName: socket,
        configFile: "/dev/null",
        executable: binary!,
      }),
  });
  let owner: SessionRuntimeTerminalReplicaOwner | undefined;
  try {
    run("new-session", "-d", "-s", "clear", "-x", "30", "-y", "12", "sleep 60");
    run("set-option", "-g", "history-limit", "30");
    run("set-option", "-g", "status", "off");
    run(
      "new-window",
      "-d",
      "-t",
      "clear",
      "-n",
      "history",
      `stty -opost -echo; read go; cat '${input}'; printf '\\033]2;DONE\\007'; exec sleep 60`,
    );
    const target = "clear:history";
    const paneId = (await mirror.describeSession("clear")).panes.find(
      (pane) => pane.windowName === "history",
    )!.semanticPaneId;
    owner = new SessionRuntimeTerminalReplicaOwner(
      "00000000-0000-4000-8000-000000000001",
      "clear",
      paneId,
      mirror,
      { incarnation: "clear:0", initialRevision: 0 },
    );
    let state: ReturnType<typeof applyTerminalReplicaUpdate>["state"] = null;
    await owner.subscribe((update: CanonicalTerminalReplicaUpdate) => {
      state = applyTerminalReplicaUpdate(state, update).state;
    });
    // The output arrives live, after the replica is subscribed.
    run("send-keys", "-t", target, "Enter");
    const rowText = (row: TerminalReplicaSnapshot["history"][number]) =>
      row.cells
        .map((cell) => cell.grapheme)
        .join("")
        .trimEnd();
    await vi.waitFor(
      () => {
        expect(run("display-message", "-p", "-t", target, "#{pane_title}")).toBe("DONE");
        const size = Number(run("display-message", "-p", "-t", target, "#{history_size}"));
        const tmuxRows = run("capture-pane", "-p", "-t", target, "-S", `-${size}`, "-E", "-1")
          .split("\n")
          .map((row) => row.trimEnd());
        const snapshot = (state as { snapshot: TerminalReplicaSnapshot } | null)?.snapshot;
        expect(snapshot?.history.map(rowText)).toEqual(tmuxRows);
      },
      { timeout: 5000 },
    );
  } finally {
    await owner?.dispose();
    try {
      run("kill-server");
    } catch {
      // Already gone.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
