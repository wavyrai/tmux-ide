import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { resolveTmuxExecutable } from "../../lib/tmux-client-execution.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";

/**
 * #869: the first open of a pane must not depend on how much history the pane
 * holds. On upstream tmux 3.8 `capture-pane -R` is a text dump of the whole
 * grid (28 MB for 2,000 lines at 120 columns) and ignores -S, so a capability
 * probe that asks for it can neither finish inside a command deadline nor fit
 * the reply cap. Runs against TMUX_IDE_BOUNDARY_TEST_BINARY when set, else the
 * tmux on PATH; it holds for every supported tmux and fails before the fix on
 * the ones whose -R is upstream's.
 */
const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY ?? resolveTmuxExecutable();
const COLUMNS = 120;
const ROWS = 40;

describe.each([
  { name: "a full default history", historyLimit: 2_000, printed: 3_000 },
  { name: "a full 50,000-line history", historyLimit: 50_000, printed: 52_000 },
])("first open of a pane with $name", ({ historyLimit, printed }) => {
  it("seeds the pane without a fault, and a second open seeds it again", async ({ skip }) => {
    const root = mkdtempSync("/tmp/lho-");
    const socketPath = join(root, "t.sock");
    const env = { ...process.env, HOME: root, TMUX: "", LC_ALL: "en_US.UTF-8" };
    const tmux = (...args: string[]) => {
      const result = spawnSync(binary, ["-S", socketPath, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.status !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr}`);
      return result.stdout.trim();
    };
    let mirror: MirrorService | undefined;
    const owners: SessionRuntimeTerminalReplicaOwner[] = [];
    const faults: string[] = [];
    let serverStarted = false;
    try {
      // The server exists before the option is set; the measured pane is
      // created after it, so it gets the limit under test.
      tmux("new-session", "-d", "-s", "holder", "-x", "80", "-y", "24", "cat");
      serverStarted = true;
      tmux("set-option", "-g", "history-limit", String(historyLimit));
      tmux(
        "new-session",
        "-d",
        "-s",
        "long",
        "-x",
        String(COLUMNS),
        "-y",
        String(ROWS),
        `seq 1 ${printed}; printf '\\033]2;filled\\007'; exec cat`,
      );
      tmux("set-option", "-t", "long", "status", "off");
      await vi.waitFor(
        () => expect(tmux("display-message", "-p", "-t", "long", "#{pane_title}")).toBe("filled"),
        { timeout: 15_000, interval: 100 },
      );
      const [history, limit, width] = tmux(
        "display-message",
        "-p",
        "-t",
        "long",
        "#{history_size} #{history_limit} #{pane_width}",
      )
        .split(" ")
        .map(Number);
      expect(limit).toBe(historyLimit);
      expect(width).toBe(COLUMNS);
      // tmux drops a tenth of the history each time the limit is reached, so
      // a full history holds between 90% and 100% of it.
      expect(history).toBeGreaterThanOrEqual(historyLimit * 0.9 - ROWS);
      // tmux-ide's own tmux seeds a replica from a native grid capture, which
      // has a budget of 1,000,000 cells. A pane beyond it cannot open on that
      // build today. That is a separate defect from the probe this test pins;
      // see the PR for the follow-up.
      const nativeServer =
        spawnSync(
          binary,
          ["-S", socketPath, "capture-pane", "-p", "-V", "-R", "-S", "0", "-E", "0", "-t", "long"],
          { env, encoding: "utf8", timeout: 10_000 },
        ).status === 0;
      if (nativeServer && COLUMNS * (history! + ROWS) > 1_000_000)
        skip("tmux-ide's tmux: this history is over the native capture's cell budget");

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
      const open = async (): Promise<{ snapshot: TerminalReplicaSnapshot; elapsedMs: number }> => {
        const owner = new SessionRuntimeTerminalReplicaOwner(
          randomUUID(),
          "long",
          pane.semanticPaneId,
          mirror!,
          {
            incarnation: randomUUID(),
            initialRevision: 0,
            onFault: (error) => faults.push(String(error)),
          },
        );
        owners.push(owner);
        let snapshot: TerminalReplicaSnapshot | null = null;
        const startedAt = performance.now();
        await owner.subscribe((update) => {
          if (update.type === "terminal.seed") snapshot = update.snapshot;
        });
        await vi.waitFor(() => expect(snapshot).not.toBeNull(), { timeout: 6_000, interval: 20 });
        return { snapshot: snapshot!, elapsedMs: performance.now() - startedAt };
      };
      const text = (snapshot: TerminalReplicaSnapshot) =>
        snapshot.grid.map((row) => row.cells.map((cell) => cell.grapheme).join("")).join("\n");

      const first = await open();
      expect(faults).toEqual([]);
      expect(text(first.snapshot)).toContain(String(printed));
      // A second viewer of the same pane, and a reopen after both left, take
      // the same path with the channel's capability already decided.
      const second = await open();
      expect(text(second.snapshot)).toContain(String(printed));
      for (const owner of owners.splice(0)) await owner.dispose();
      const reopened = await open();
      expect(text(reopened.snapshot)).toContain(String(printed));
      expect(faults).toEqual([]);
      console.info(
        `[long-history-open] ${tmux("display-message", "-p", "#{version}")} history ${history}/${limit}: ` +
          `first open ${first.elapsedMs.toFixed(0)} ms, second ${second.elapsedMs.toFixed(0)} ms, ` +
          `reopen ${reopened.elapsedMs.toFixed(0)} ms`,
      );
    } finally {
      for (const owner of owners) await owner.dispose().catch(() => undefined);
      await mirror?.dispose().catch(() => undefined);
      if (serverStarted) spawnSync(binary, ["-S", socketPath, "kill-server"], { env });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
