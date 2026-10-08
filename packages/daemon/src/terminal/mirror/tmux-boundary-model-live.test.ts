import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { applyTerminalReplicaPatch } from "@tmux-ide/core";
import { defaultNodePtyAdapter } from "../NodePtyAdapter.ts";
import type { PtyProcess } from "../PtyAdapter.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";
import { MirrorService, type MirrorSubscription } from "./mirror-service.ts";

// An explicit binary is required so a missing prerequisite fails this gate,
// rather than silently turning a bundled-runtime qualification into a skip.
const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;

it.skipIf(!binary)(
  "matches native checkpoints through attach, output, client resize and reconnect",
  async () => {
    expect(
      binary,
      "Run pnpm test:tmux-boundary with TMUX_IDE_BOUNDARY_TEST_BINARY set",
    ).toBeTruthy();
    const socket = `zz-boundary-${process.pid}-${randomUUID().slice(0, 8)}`;
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TMUX: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    let client: PtyProcess | undefined;
    let mirror: MirrorService | undefined;
    let owner: SessionRuntimeTerminalReplicaOwner | undefined;
    let input: MirrorSubscription | undefined;
    let snapshot: TerminalReplicaSnapshot | null = null;
    let updateCount = 0;
    const faults: unknown[] = [];
    const text = () =>
      snapshot
        ? [...snapshot.history, ...snapshot.grid]
            .map((row) =>
              row.cells
                .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
                .join("")
                .trimEnd(),
            )
            .join("\n")
            .trimEnd()
        : "";
    try {
      console.info(`tmux boundary binary: ${binary}; ${run("-V")}`);
      // No interactive shell prompt or line echo can masquerade as processed output.
      run(
        "new-session",
        "-d",
        "-s",
        "boundary",
        "-x",
        "80",
        "-y",
        "24",
        "stty -echo; printf 'READY\\r\\n'; while IFS= read -r line; do printf '%b\\r\\n' \"$line\"; done",
      );
      run("set-option", "-t", "boundary", "status", "off");
      run("set-window-option", "-t", "boundary", "window-size", "latest");
      const pane = run("display-message", "-p", "-t", "boundary", "#{pane_id}");
      await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", pane)).toContain("READY"));
      client = defaultNodePtyAdapter.spawnSync(
        {
          shell: binary!,
          args: ["-L", socket, "attach", "-t", "=boundary"],
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          env: { ...process.env, TMUX: "", TERM: "xterm-256color" },
          name: "xterm-256color",
          encoding: null,
        },
        { onData: () => undefined, onExit: () => undefined },
      );

      const attach = async () => {
        mirror = new MirrorService({
          executable: binary!,
          socketName: socket,
          configFile: "/dev/null",
        });
        const description = await mirror.describeSession("boundary");
        expect(description.panes).toHaveLength(1);
        const semanticPaneId = description.panes[0]!.semanticPaneId;
        owner = new SessionRuntimeTerminalReplicaOwner(
          randomUUID(),
          "boundary",
          semanticPaneId,
          mirror,
          { incarnation: randomUUID(), initialRevision: 0, onFault: (fault) => faults.push(fault) },
        );
        await owner.subscribe((update) => {
          updateCount++;
          if (update.type === "terminal.seed") snapshot = update.snapshot;
          else if (update.type === "terminal.patch" && snapshot)
            snapshot = applyTerminalReplicaPatch(snapshot, update.patch);
        });
        input = await mirror.subscribe({
          session: "boundary",
          semanticPaneId,
          onEvent: () => undefined,
        });
      };
      const checkpoint = async (label: string, cols: number, rows: number, marker: string) => {
        // The producer is quiescent once marker is processed. No sleeps or
        // command receipts are treated as proof that PTY output has been parsed.
        await vi.waitFor(
          () => {
            const native = run("capture-pane", "-p", "-S", "-", "-t", pane);
            expect(native, label).toContain(marker);
            const [width, height, x, y] = run(
              "display-message",
              "-p",
              "-t",
              pane,
              "#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}",
            )
              .split(" ")
              .map(Number);
            expect([width, height], label).toEqual([cols, rows]);
            expect([snapshot?.cols, snapshot?.rows], label).toEqual([width, height]);
            expect([snapshot?.cursor.x, snapshot?.cursor.y], label).toEqual([x, y]);
            expect(text(), label).toBe(native);
            expect(faults, label).toEqual([]);
          },
          { timeout: 5000, interval: 25 },
        );
      };
      await attach();
      await checkpoint("attach", 80, 24, "READY");
      for (let index = 0; index < 32; index++) {
        input!.sendText(`LINE-${String(index).padStart(2, "0")}`);
        input!.sendKey("Enter");
      }
      await checkpoint("input and history", 80, 24, "LINE-31");
      expect(
        text()
          .split("\n")
          .filter((line) => line.startsWith("LINE-")),
      ).toEqual(Array.from({ length: 32 }, (_, index) => `LINE-${String(index).padStart(2, "0")}`));
      input!.sendText("\\033[1;31mRED\\033[0m 界 é");
      input!.sendKey("Enter");
      await checkpoint("styled Unicode output", 80, 24, "RED 界 é");
      const richRow = snapshot!.grid.find((row) =>
        row.cells.some((cell) => cell.grapheme === "R"),
      )!;
      expect(richRow.cells[0]).toMatchObject({
        grapheme: "R",
        foreground: { kind: "indexed", index: 1 },
      });
      expect(richRow.cells[0]!.attributes & 1).toBe(1);
      expect(richRow.cells.find((cell) => cell.grapheme === "界")?.width).toBe(2);
      for (const [cols, rows] of [
        [43, 12],
        [100, 30],
        [60, 18],
      ]) {
        client.resize(cols!, rows!);
        const marker = `SIZE-${cols}-${rows}`;
        input!.sendText(marker);
        input!.sendKey("Enter");
        await checkpoint("client resize", cols!, rows!, marker);
      }
      await owner!.dispose();
      owner = undefined;
      const retired = snapshot;
      const retiredUpdateCount = updateCount;
      await mirror!.dispose();
      mirror = undefined;
      run("send-keys", "-t", pane, "-l", "WHILE-DISCONNECTED");
      run("send-keys", "-t", pane, "Enter");
      await vi.waitFor(() =>
        expect(run("capture-pane", "-p", "-t", pane)).toContain("WHILE-DISCONNECTED"),
      );
      expect(snapshot).toBe(retired);
      expect(updateCount).toBe(retiredUpdateCount);
      snapshot = null;
      await attach();
      await checkpoint("reconnect", 60, 18, "WHILE-DISCONNECTED");
      input!.sendText("AFTER-RECOVERY");
      input!.sendKey("Enter");
      await checkpoint("recovered live input", 60, 18, "AFTER-RECOVERY");
    } finally {
      try {
        try {
          await owner?.dispose();
        } finally {
          await mirror?.dispose();
        }
      } finally {
        try {
          client?.kill("SIGKILL");
        } finally {
          spawnSync(binary!, ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5000 });
          expect(
            spawnSync(binary!, ["-L", socket, "has-session"], {
              stdio: "ignore",
              timeout: 5000,
            }).status,
          ).toBe(1);
        }
      }
    }
  },
  30000,
);
