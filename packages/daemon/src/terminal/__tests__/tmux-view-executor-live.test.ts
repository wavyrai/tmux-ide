import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GROUPED_TMUX_VIEW_MARKER_OPTION,
  GROUPED_TMUX_VIEW_SESSION_PREFIX,
  planGroupedTmuxAttachment,
  type TmuxArgvPlan,
} from "../attachments/grouped-tmux.ts";
import {
  TmuxAttachmentViewExecutor,
  type TmuxAttachmentCommandResult,
  type TmuxAttachmentCommandRunner,
} from "../attachments/tmux-view-executor.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `tmux-ide-executor-${process.pid}-${randomUUID().slice(0, 8)}`;
const sleepCommand = "exec sleep 2147483647";

function runOnSocket(argv: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

class LiveSocketRunner implements TmuxAttachmentCommandRunner {
  beforeServerGuard: (() => void) | undefined;

  run(command: TmuxArgvPlan): TmuxAttachmentCommandResult {
    try {
      if (command.argv[0] === "if-shell" && !command.argv[3]?.startsWith("=")) {
        const mutate = this.beforeServerGuard;
        this.beforeServerGuard = undefined;
        mutate?.();
      }
      const result = { status: "ok" as const, stdout: runOnSocket(command.argv) };
      return result;
    } catch (error) {
      const stderr = String((error as { stderr?: string | Buffer }).stderr ?? "").toLowerCase();
      const result: TmuxAttachmentCommandResult =
        /(?:can't find|no such|not found|no server running)/u.test(stderr)
          ? { status: "not-found" }
          : { status: "failed" };
      return result;
    }
  }
}

describe.skipIf(!hasTmux)("TmuxAttachmentViewExecutor live server guards", () => {
  const runner = new LiveSocketRunner();
  let sessionId = "";
  let windowId = "";
  let paneId = "";

  beforeAll(() => {
    runOnSocket(["new-session", "-d", "-s", "durable-source", "-n", "authorized", sleepCommand]);
    sessionId = runOnSocket([
      "display-message",
      "-p",
      "-t",
      "durable-source",
      "#{session_id}",
    ]).trim();
    windowId = runOnSocket([
      "display-message",
      "-p",
      "-t",
      "durable-source",
      "#{window_id}",
    ]).trim();
    paneId = runOnSocket(["display-message", "-p", "-t", "durable-source", "#{pane_id}"]).trim();
  });

  afterAll(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  });

  function livePlan(attachmentId: string) {
    return planGroupedTmuxAttachment({
      attachmentId,
      generation: 0,
      target: { workspaceName: "workspace.live", semanticPaneId: "pane.authorized" },
      viewerMode: "read-only",
      viewport: { cols: 120, rows: 40 },
      source: { sessionId, windowId, runtimePaneId: paneId, paneCount: 1 },
    });
  }

  function liveOperation(selectedPlan: ReturnType<typeof livePlan>) {
    return {
      operation: "create" as const,
      exactViewSessionTarget: `=${selectedPlan.identity.viewSessionName}` as const,
      deadline: 2_000,
      source: { sessionId, windowId, runtimePaneId: paneId, paneCount: 1 as const },
      plan: selectedPlan,
    };
  }

  it("creates, strictly enumerates, and atomically cleans a real grouped tmux view", async () => {
    const selectedPlan = livePlan("7ff5a4a4-998f-4ee9-9b8b-b90ddf449c62");
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });

    await expect(executor.executeGuardedViewOperation(liveOperation(selectedPlan))).resolves.toBe(
      "executed",
    );
    await expect(
      executor.enumerateMarkedViews(
        GROUPED_TMUX_VIEW_SESSION_PREFIX,
        GROUPED_TMUX_VIEW_MARKER_OPTION,
      ),
    ).resolves.toContainEqual({
      viewSessionName: selectedPlan.identity.viewSessionName,
      markerValue: selectedPlan.identity.markerValue,
      windowIds: [windowId],
    });
    const cleanupResult = await executor.guardedCleanup({
      exactViewSessionTarget: `=${selectedPlan.identity.viewSessionName}`,
      markerOption: GROUPED_TMUX_VIEW_MARKER_OPTION,
      expectedMarkerValue: selectedPlan.identity.markerValue,
      expectedWindowId: windowId,
    });
    expect(cleanupResult).toBe("cleaned");
    expect(() =>
      runOnSocket(["has-session", "-t", `=${selectedPlan.identity.viewSessionName}`]),
    ).toThrow();
    expect(runOnSocket(["display-message", "-p", "-t", paneId, "#{pane_dead}"]).trim()).toBe("0");
  });

  it("falsifies the server guard when an external client splits after daemon proof", async () => {
    const selectedPlan = livePlan("ea7d29fa-9b57-42a8-bdd0-3b4c22aee962");
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    let addedPane = "";
    runner.beforeServerGuard = () => {
      addedPane = runOnSocket([
        "split-window",
        "-d",
        "-t",
        paneId,
        "-P",
        "-F",
        "#{pane_id}",
        sleepCommand,
      ]).trim();
    };

    await expect(executor.executeGuardedViewOperation(liveOperation(selectedPlan))).resolves.toBe(
      "source-proof-mismatch",
    );
    expect(() =>
      runOnSocket(["has-session", "-t", `=${selectedPlan.identity.viewSessionName}`]),
    ).toThrow();
    expect(addedPane).toMatch(/^%(?:0|[1-9][0-9]*)$/u);
    runOnSocket(["kill-pane", "-t", addedPane]);
    expect(runOnSocket(["display-message", "-p", "-t", paneId, "#{window_panes}"]).trim()).toBe(
      "1",
    );
  });
});
