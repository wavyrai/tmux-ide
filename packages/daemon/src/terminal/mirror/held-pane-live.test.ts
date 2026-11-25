import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveTmuxExecutable } from "../../lib/tmux-client-execution.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";
import { MirrorPaneHeldError } from "./pane-hold.ts";
import { SessionRuntimeTerminalReplicaOwner } from "../session-runtime/terminal-replica-owner.ts";

/**
 * #872, against a real tmux on a private socket: a pane whose capture is over
 * the size cap fails its opens, is then held, and the refusal says so (with
 * the time left and "too-large"). A person's retry asks tmux inside the hold,
 * and `clear-history` ends even a long hold within about a second, which is
 * when tmux reports the pane's new history size. Runs against
 * TMUX_IDE_BOUNDARY_TEST_BINARY when set, else the tmux on PATH.
 */
const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY ?? resolveTmuxExecutable();
const COLUMNS = 1_000;
const ROWS = 20;
/** 20,000 full rows of 1,000 columns: about 20 MB of text, over the 16 MiB cap. */
const PRINTED = 20_000;

describe("a pane whose capture is over the size cap", () => {
  it("is held after two failures, says why, and opens soon after clear-history", async ({
    skip,
  }) => {
    const root = mkdtempSync("/tmp/hpl-");
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
    let serverStarted = false;
    try {
      tmux("new-session", "-d", "-s", "holder", "-x", "80", "-y", "24", "cat");
      serverStarted = true;
      tmux("set-option", "-g", "history-limit", String(PRINTED + 5_000));
      const line = "x".repeat(COLUMNS);
      tmux(
        "new-session",
        "-d",
        "-s",
        "wide",
        "-x",
        String(COLUMNS),
        "-y",
        String(ROWS),
        `yes ${line} | head -n ${PRINTED}; printf '\\033]2;filled\\007'; exec cat`,
      );
      tmux("set-option", "-t", "wide", "status", "off");
      await vi.waitFor(
        () => expect(tmux("display-message", "-p", "-t", "wide", "#{pane_title}")).toBe("filled"),
        { timeout: 30_000, interval: 100 },
      );
      expect(
        Number(tmux("display-message", "-p", "-t", "wide", "#{history_size}")),
      ).toBeGreaterThan(PRINTED - ROWS - 10);

      // tmux-ide's own tmux seeds from a native grid capture with a budget of
      // 1,000,000 cells, and a pane beyond it fails another way today (#873).
      const nativeServer =
        spawnSync(
          binary,
          ["-S", socketPath, "capture-pane", "-p", "-V", "-R", "-S", "0", "-E", "0", "-t", "wide"],
          { env, encoding: "utf8", timeout: 10_000 },
        ).status === 0;
      if (nativeServer)
        skip("tmux-ide's tmux: this pane is over the native capture's cell budget (#873)");

      const service = new MirrorService({
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
      mirror = service;
      // A stream keeps the session's channel (its layout subscription); so
      // does this, or each open would get a new channel with no hold.
      const retention = await service.retainSession("wide");
      const pane = (await service.describeSession("wide")).panes[0]!.semanticPaneId;
      /** One open: "opened", the plain failure's message, or the hold. */
      const open = async (): Promise<"opened" | string | MirrorPaneHeldError> => {
        const owner = new SessionRuntimeTerminalReplicaOwner(randomUUID(), "wide", pane, service, {
          incarnation: randomUUID(),
          initialRevision: 0,
        });
        let seeded = false;
        try {
          await owner.subscribe((update) => {
            if (update.type === "terminal.seed") seeded = true;
          });
          await vi.waitFor(() => expect(seeded).toBe(true), { timeout: 20_000, interval: 20 });
          return "opened";
        } catch (error) {
          return error instanceof MirrorPaneHeldError ? error : String(error);
        } finally {
          await owner.dispose().catch(() => undefined);
        }
      };

      // Two real failures, then a refusal that says it is one.
      expect(await open()).toBe("Error: Native terminal recovery failed");
      expect(await open()).toBe("Error: Native terminal recovery failed");
      const held = await open();
      expect(held).toBeInstanceOf(MirrorPaneHeldError);
      const hold = (held as MirrorPaneHeldError).hold;
      expect(hold.why).toBe("too-large");
      expect(hold.retryInMs).toBeGreaterThan(0);
      expect(hold.retryInMs).toBeLessThanOrEqual(2_000);

      // A person's retry asks tmux inside the hold; each failure doubles it.
      for (let retry = 0; retry < 3; retry += 1) {
        service.liftRecoveryHolds("wide", [pane]);
        expect(await open()).toBe("Error: Native terminal recovery failed");
      }
      const longer = await open();
      expect(longer).toBeInstanceOf(MirrorPaneHeldError);
      expect((longer as MirrorPaneHeldError).hold.retryInMs).toBeGreaterThan(8_000);

      // clear-history: the pane opens long before that 16 s hold ends.
      const clearedAt = performance.now();
      tmux("clear-history", "-t", "wide");
      let opened = false;
      while (!opened && performance.now() - clearedAt < 6_000) {
        const result = await open();
        if (result === "opened") opened = true;
        else {
          expect(result).toBeInstanceOf(MirrorPaneHeldError);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const elapsedMs = performance.now() - clearedAt;
      expect(opened).toBe(true);
      await retention.close();
      process.stderr.write(
        `[held-pane] ${tmux("display-message", "-p", "#{version}")}: first hold ${hold.retryInMs} ms, ` +
          `opened ${elapsedMs.toFixed(0)} ms after clear-history\n`,
      );
    } finally {
      await mirror?.dispose().catch(() => undefined);
      if (serverStarted) spawnSync(binary, ["-S", socketPath, "kill-server"], { env });
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
