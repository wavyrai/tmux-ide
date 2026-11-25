import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { applyTerminalReplicaUpdate, type TerminalReplicaState } from "@tmux-ide/core";
import { resolveTmuxExecutable } from "../../lib/tmux-client-execution.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";
import { nativeSeedHistoryRows } from "./native-grid-capture.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";
import { DAEMON_HISTORY_ROW_CAP } from "../session-runtime/terminal-interpreter-backend.ts";

/**
 * #873: on tmux-ide's own tmux a pane seeds its replica from a native grid
 * capture, whose budget is 1,000,000 cells and 16 MiB. Before the fix a pane
 * with more history than that never opened. Now the first open reads the
 * screen and the newest history that fits the seed budget, and the rest
 * follows in pieces until the replica holds every row tmux holds, with the
 * same text and the same wrapped lines. Runs against
 * TMUX_IDE_BOUNDARY_TEST_BINARY when set, else the tmux on PATH, and only when
 * that tmux is tmux-ide's build (upstream tmux has no native capture).
 */
const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY ?? resolveTmuxExecutable();
const ROWS = 40;

type Row = TerminalReplicaSnapshot["history"][number];

describe.each([
  { columns: 120, historyLimit: 50_000, printed: 52_000 },
  { columns: 200, historyLimit: 10_000, printed: 11_000 },
  { columns: 200, historyLimit: 2_000, printed: 3_000 },
])(
  "first open of a $columns-column pane with a full $historyLimit-line history",
  ({ columns, historyLimit, printed }) => {
    it("opens at once and then holds tmux's newest history rows up to the daemon's cap", async ({
      skip,
    }) => {
      const root = mkdtempSync("/tmp/cbo-");
      const socketPath = join(root, "t.sock");
      const env = { ...process.env, HOME: root, TMUX: "", LC_ALL: "en_US.UTF-8" };
      const tmux = (...args: string[]) => {
        const result = spawnSync(binary, ["-S", socketPath, "-f", "/dev/null", ...args], {
          env,
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 256 * 1024 * 1024,
        });
        if (result.status !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr}`);
        return result.stdout;
      };
      let mirror: MirrorService | undefined;
      let owner: SessionRuntimeTerminalReplicaOwner | undefined;
      const faults: string[] = [];
      let serverStarted = false;
      try {
        tmux("new-session", "-d", "-s", "holder", "-x", "80", "-y", "24", "cat");
        serverStarted = true;
        const nativeServer =
          spawnSync(
            binary,
            [
              "-S",
              socketPath,
              "capture-pane",
              "-p",
              "-V",
              "-R",
              "-S",
              "0",
              "-E",
              "0",
              "-t",
              "holder",
            ],
            { env, encoding: "utf8", timeout: 10_000 },
          ).status === 0;
        if (!nativeServer && process.env.TMUX_IDE_ORACLE_EXPECT_NATIVE === "1")
          throw new Error("TMUX_IDE_ORACLE_EXPECT_NATIVE=1, but this tmux has no native capture");
        if (!nativeServer) skip("not tmux-ide's tmux: no native capture to budget");
        tmux("set-option", "-g", "history-limit", String(historyLimit));
        // Every seventh line is longer than the pane and wraps, so the joins
        // between pieces carry wrapped rows too.
        const fill =
          `awk 'BEGIN{for(i=1;i<=${printed};i++) printf "%0*d\\n", (i%7==0 ? ${columns * 2 + 10} : ${columns - 20}), i}'` +
          `; printf '\\033]2;filled\\007'; exec cat`;
        tmux("new-session", "-d", "-s", "long", "-x", String(columns), "-y", String(ROWS), fill);
        tmux("set-option", "-t", "long", "status", "off");
        await vi.waitFor(
          () =>
            expect(tmux("display-message", "-p", "-t", "long", "#{pane_title}").trim()).toBe(
              "filled",
            ),
          { timeout: 30_000, interval: 100 },
        );
        const [history, width] = tmux(
          "display-message",
          "-p",
          "-t",
          "long",
          "#{history_size} #{pane_width}",
        )
          .trim()
          .split(" ")
          .map(Number);
        expect(width).toBe(columns);
        expect(history).toBeGreaterThanOrEqual(historyLimit * 0.9 - ROWS);

        mirror = new MirrorService({
          executable: binary,
          socketPath,
          configFile: "/dev/null",
          createIo: (session, handlers) =>
            new MirrorControlChannel({
              executable: binary,
              socketPath,
              configFile: "/dev/null",
              session,
              handlers,
            }),
        });
        const description = await mirror.describeSession("long");
        const pane = description.panes[0]!;
        owner = new SessionRuntimeTerminalReplicaOwner(
          randomUUID(),
          "long",
          pane.semanticPaneId,
          mirror,
          {
            incarnation: randomUUID(),
            initialRevision: 0,
            onFault: (error) => faults.push(String(error)),
          },
        );
        // Every update goes through the client's reducer, which checks each
        // revision's state hash: a prepended piece must be a valid revision.
        let state: TerminalReplicaState | null = null;
        let firstSeedHistory: number | null = null;
        const rejected: string[] = [];
        const startedAt = performance.now();
        let openedMs: number | null = null;
        await owner.subscribe((update: CanonicalTerminalReplicaUpdate) => {
          const result = applyTerminalReplicaUpdate(state, update);
          if (result.status !== "applied" && result.status !== "idempotent") {
            rejected.push(result.status);
            return;
          }
          state = result.state;
          if (update.type === "terminal.seed" && firstSeedHistory === null) {
            firstSeedHistory = update.snapshot.history.length;
            openedMs = performance.now() - startedAt;
          }
        });
        await vi.waitFor(() => expect(openedMs).not.toBeNull(), { timeout: 6_000, interval: 20 });
        expect(faults).toEqual([]);
        const text = (row: Row) =>
          row.cells
            .map((cell) => cell.grapheme)
            .join("")
            .trimEnd();
        const screen = state!.snapshot!.grid.map(text).join("\n");
        expect(screen).toContain(String(printed).padStart(columns - 20, "0"));
        // The first open reads no more history than the seed budget allows.
        expect(firstSeedHistory!).toBeLessThanOrEqual(nativeSeedHistoryRows(columns, ROWS));

        // The daemon holds at most DAEMON_HISTORY_ROW_CAP rows; tmux keeps the rest.
        const held = Math.min(history!, DAEMON_HISTORY_ROW_CAP);
        await vi.waitFor(() => expect(state!.snapshot!.history.length).toBe(held), {
          timeout: 90_000,
          interval: 100,
        });
        const filledMs = performance.now() - startedAt;
        // It then stops reading: nothing changes while the pane is idle.
        const settled = state!.revision;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(state!.revision).toBe(settled);
        expect(state!.snapshot!.history).toHaveLength(held);
        expect(rejected).toEqual([]);
        expect(faults).toEqual([]);
        // Same rows as tmux, joined at the same wraps.
        const logical: string[] = [];
        for (const row of state!.snapshot!.history) {
          if (row.wrapped && logical.length > 0) logical[logical.length - 1] += text(row);
          else logical.push(text(row));
        }
        const expected = tmux(
          "capture-pane",
          "-p",
          "-J",
          "-S",
          `-${held}`,
          "-E",
          "-1",
          "-t",
          "long",
        )
          .replace(/\n$/u, "")
          .split("\n")
          .map((line) => line.trimEnd());
        expect(logical.length).toBe(expected.length);
        expect(logical).toEqual(expected);
        console.info(
          `[capture-budget-open] ${tmux("display-message", "-p", "#{version}").trim()} ` +
            `${columns}x${ROWS}, history ${history}: first open ${openedMs!.toFixed(0)} ms ` +
            `with ${firstSeedHistory} rows, ${held} rows after ${filledMs.toFixed(0)} ms`,
        );
      } finally {
        await owner?.dispose().catch(() => undefined);
        await mirror?.dispose().catch(() => undefined);
        if (serverStarted) spawnSync(binary, ["-S", socketPath, "kill-server"], { env });
        rmSync(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
