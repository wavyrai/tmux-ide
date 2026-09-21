/**
 * Live proof, against the CLI under test: killing the private tmux server
 * leaves the daemon alive and reporting the gap, `tmux-ide restore` rebuilds
 * the fleet from the updater's snapshot on the same socket, the daemon
 * re-binds to the replacement server as a new generation, and a 1,000-event
 * send-keys burst against a restored pane (with the daemon paused so it
 * cannot drain) is retained bounded with a framed gap marker, reported as an
 * `overflow` gap once the daemon resumes, and never fails the reader.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertUnifiedSocket,
  createPrivateFleet,
  tmuxAvailable,
  type PrivateFleet,
} from "./installed-recovery-fixture.ts";

const HOOK_MARKER = "tmux-ide-interaction-v3";
const MAX_RETAINED_BYTES = 9_269;

describe
  .skipIf(!tmuxAvailable)
  .sequential("installed tmux server death, restore and burst (live)", () => {
    let fleet: PrivateFleet;
    let projectDir = "";

    beforeAll(async () => {
      fleet = await createPrivateFleet("restore");
      projectDir = join(fleet.root, "project");
      mkdirSync(projectDir);
      fleet.tmux("-f", "/dev/null", "new-session", "-d", "-s", "zz-keeper", "exec sleep 300");
      assertUnifiedSocket(fleet);
      // Fast updater cadence so the snapshot lands within a second of adopt.
      writeFileSync(
        fleet.env.TMUX_IDE_CONFIG!,
        JSON.stringify({ updater: { tickMs: 250, snapshotEvery: 1 } }),
      );
    }, 60_000);

    afterAll(async () => {
      await fleet?.cleanup();
    }, 45_000);

    it("reports the gap, restores from the snapshot, re-binds, and bounds a burst", async () => {
      fleet.tmux("new-session", "-d", "-s", "project", "-n", "editor", "-c", projectDir);
      fleet.tmux("new-window", "-t", "project", "-n", "shell", "-c", fleet.root);
      fleet.tmux("split-window", "-t", "project:shell", "-h", "-c", fleet.root);
      fleet.tmux("select-layout", "-t", "project:shell", "even-horizontal");
      const adopt = await fleet.bounded(
        fleet.exit(fleet.cli(["adopt", "project", "--json"])),
        "adopt",
      );
      expect(adopt.code, adopt.stderr).toBe(0);
      const snapshotPath = join(fleet.stateDir, "snapshot.json");
      const snapshot = await fleet.until(() => {
        try {
          const parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
          return parsed.sessions?.some((session: { name: string }) => session.name === "project")
            ? parsed
            : null;
        } catch {
          return null;
        }
      }, "updater snapshot");
      const projectSnapshot = snapshot.sessions.find(
        (session: { name: string }) => session.name === "project",
      );
      expect(projectSnapshot.windows).toHaveLength(2);
      expect(
        projectSnapshot.windows.map((window: { panes: unknown[] }) => window.panes.length),
      ).toEqual([1, 2]);
      expect(fleet.tmuxStatus("has-session", "-t", "_tmux-ide-chrome")).toBe(0);
      fleet.evidence({
        scenario: 3,
        step: "snapshot",
        savedAt: snapshot.savedAt,
        sessions: snapshot.sessions.map((session: { name: string }) => session.name),
      });

      const first = await fleet.startDaemon();
      const events = fleet.eventsClient(first.info);
      await fleet.bounded(events.ready, "events subscription");
      await fleet.until(
        () =>
          fleet
            .tmux("show-hooks", "-g", "after-send-keys")
            .includes(`${HOOK_MARKER}-${first.info.instanceId}`)
            ? true
            : null,
        "observer hooks on the first server",
      );
      const serverPidBefore = fleet.tmux("display-message", "-p", "#{pid}");

      // Kill only this fixture's server.
      fleet.tmux("kill-server");
      await fleet.until(() => (fleet.tmuxStatus("has-session") !== 0 ? true : null), "server gone");
      const killedAt = Date.now();
      // The daemon must survive the dead server: healthy across several probes.
      for (let probe = 0; probe < 4; probe += 1) {
        const health = (await fleet.fetchJson(first.info, "/health")) as { ok: boolean };
        expect(health.ok).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(first.child.exitCode).toBeNull();
      const infoDuringGap = JSON.parse(
        (await fleet.bounded(fleet.exit(fleet.cli(["daemon", "info", "--json"])), "daemon info"))
          .stdout,
      );
      expect(infoDuringGap).toMatchObject({
        status: "running",
        daemon: { pid: first.info.pid, instanceId: first.info.instanceId },
      });
      const teamDuringGap = await fleet.bounded(
        fleet.exit(fleet.cli(["team", "--json"])),
        "team during gap",
      );
      const logsDuringGap = await fleet.logBackfill(first.info);
      const gapReports = logsDuringGap.filter(
        (entry) =>
          entry.level === "warn" ||
          entry.level === "error" ||
          /tmux/iu.test(String(entry.component)),
      );
      fleet.evidence({
        scenario: 3,
        step: "during-gap",
        msSinceKill: Date.now() - killedAt,
        teamExit: teamDuringGap.code,
        teamStdout: teamDuringGap.stdout.slice(0, 400),
        teamStderr: teamDuringGap.stderr.slice(0, 400),
        logEntries: logsDuringGap.length,
        gapReports: gapReports.slice(-8).map((entry) => ({
          level: entry.level,
          component: entry.component,
          msg: entry.msg,
          data: entry.data,
        })),
      });

      // Restore from the snapshot taken before the kill, on the same socket.
      const restore = await fleet.bounded(
        fleet.exit(fleet.cli(["restore", "--json"])),
        "restore",
        30000,
      );
      expect(restore.code, restore.stderr).toBe(0);
      fleet.evidence({ scenario: 3, step: "restore", stdout: restore.stdout.slice(0, 1200) });
      expect(fleet.tmuxStatus("has-session", "-t", "project")).toBe(0);
      expect(fleet.tmux("display-message", "-p", "#{pid}")).not.toBe(serverPidBefore);
      expect(
        fleet.tmux("list-windows", "-t", "project", "-F", "#{window_name}:#{window_panes}"),
      ).toBe("editor:1\nshell:2");
      expect(
        fleet.tmux("display-message", "-p", "-t", "project:shell", "#{pane_current_path}"),
      ).toBe(realpathSync(fleet.root));
      expect(
        fleet.tmux("display-message", "-p", "-t", "project:editor", "#{pane_current_path}"),
      ).toBe(realpathSync(projectDir));

      // The daemon re-binds to the replacement server as a new generation.
      const second = await fleet.until(
        () => {
          const value = fleet.info();
          return value && value.instanceId !== first.info.instanceId ? value : null;
        },
        "daemon generation restart",
        20000,
      );
      expect(second.pid).toBe(first.info.pid);
      expect(first.child.exitCode).toBeNull();
      const closeCode = await fleet.bounded(events.closed, "old generation events close", 15000);
      const health = await fleet.fetchJson(second, "/health").catch(() => null);
      expect(health).toMatchObject({ ok: true });
      const infoAfter = JSON.parse(
        (await fleet.bounded(fleet.exit(fleet.cli(["daemon", "info", "--json"])), "daemon info"))
          .stdout,
      );
      expect(infoAfter).toMatchObject({
        status: "running",
        daemon: { pid: first.info.pid, instanceId: second.instanceId },
      });
      const logsAfterRestart = await fleet.logBackfill(second);
      fleet.evidence({
        scenario: 3,
        step: "after-restore",
        oldEventsCloseCode: closeCode,
        newInstanceId: second.instanceId,
        samePid: second.pid === first.info.pid,
        restartLogs: logsAfterRestart
          .filter((entry) =>
            /restart|generation|authority|replace|retire|tmux/iu.test(
              `${entry.component} ${entry.msg}`,
            ),
          )
          .slice(-10)
          .map((entry) => ({
            level: entry.level,
            component: entry.component,
            msg: entry.msg,
            data: entry.data,
          })),
      });

      // Scenario 4: burst against a restored pane with the daemon paused.
      const eventsAfter = fleet.eventsClient(second);
      await fleet.bounded(eventsAfter.ready, "events subscription on new generation");
      await fleet.until(
        () =>
          fleet
            .tmux("show-hooks", "-g", "after-send-keys")
            .includes(`${HOOK_MARKER}-${second.instanceId}`)
            ? true
            : null,
        "observer hooks on the restored server",
        20000,
      );
      const option = `@${HOOK_MARKER}-${second.instanceId}`;
      const restoredPane = fleet.tmux("display-message", "-p", "-t", "project:shell", "#{pane_id}");
      const script = join(fleet.root, "burst.tmux");
      writeFileSync(
        script,
        Array.from({ length: 1_000 }, () => `send-keys -t ${restoredPane} -l x`).join("\n"),
      );
      const logsBeforeBurst = (await fleet.logBackfill(second)).length;
      // Pause the daemon so nothing drains the batch while the burst lands;
      // the retained option is then a deterministic view of the hooks alone.
      const burstWhilePaused = (): { retained: string; burstMs: number } => {
        process.kill(first.info.pid, "SIGSTOP");
        try {
          const startedAt = Date.now();
          fleet.tmux("source-file", script);
          const burstMs = Date.now() - startedAt;
          fleet.tmux("send-keys", "-t", restoredPane, "-l", "z");
          return { retained: fleet.tmux("show-options", "-gv", option), burstMs };
        } finally {
          process.kill(first.info.pid, "SIGCONT");
        }
      };
      const { retained, burstMs } = burstWhilePaused();
      expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(MAX_RETAINED_BYTES);
      expect(retained).toContain("|gap|");
      // The resumed daemon drains the bounded batch, reports the gap, and keeps
      // observing: a later send is consumed and the option returns to empty.
      let gapWarning: Record<string, unknown> | undefined;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !gapWarning) {
        const entries = await fleet.logBackfill(second);
        gapWarning = entries.find(
          (entry) =>
            /observation gap/iu.test(String(entry.msg)) &&
            (entry.data as { reason?: string } | undefined)?.reason === "overflow",
        );
        if (!gapWarning) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(
        gapWarning,
        `no overflow gap warning among ${logsBeforeBurst}+ log entries`,
      ).toBeTruthy();
      fleet.tmux("send-keys", "-t", restoredPane, "-l", "y");
      await fleet.until(
        () => (fleet.tmux("show-options", "-gqv", option) === "" ? true : null),
        "batch drained after resume",
        15000,
      );
      expect((await fleet.fetchJson(second, "/health")) as { ok: boolean }).toMatchObject({
        ok: true,
      });
      expect(eventsAfter.frames.some((frame) => frame.type === "hello")).toBe(true);
      const infoFinal = JSON.parse(
        (await fleet.bounded(fleet.exit(fleet.cli(["daemon", "info", "--json"])), "daemon info"))
          .stdout,
      );
      expect(infoFinal).toMatchObject({
        status: "running",
        daemon: { instanceId: second.instanceId },
      });
      fleet.evidence({
        scenario: 4,
        step: "burst",
        burstMs,
        retainedBytes: Buffer.byteLength(retained),
        retainedHasGap: retained.includes("|gap|"),
        gapWarning: {
          component: gapWarning?.component,
          msg: gapWarning?.msg,
          data: gapWarning?.data,
        },
        eventsClientOpen: eventsAfter.frames.length > 0,
        pane: restoredPane,
      });
      // The pane only ever received literal keystrokes.
      expect(fleet.tmux("capture-pane", "-p", "-t", restoredPane)).toContain("x".repeat(20));
      eventsAfter.close();
    }, 120_000);
  });
