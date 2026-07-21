import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planGroupedTmuxAttachment, type TmuxArgvPlan } from "../attachments/grouped-tmux.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `tmux-ide-attachment-${process.pid}-${randomUUID().slice(0, 8)}`;
const sourceName = "durable-source";
const sleepCommand = "exec sleep 2147483647";

function runTmux(argv: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function runPlan(command: TmuxArgvPlan): string {
  expect(command.executable).toBe("tmux");
  return runTmux(command.argv);
}

describe.skipIf(!hasTmux)("grouped tmux attachment live isolation", () => {
  let sourceSessionId = "";
  let authorizedWindowId = "";
  let authorizedPaneId = "";
  let forbiddenWindowId = "";
  let sourceSessionOptions = "";
  let sourceWindowOptions = "";

  beforeAll(() => {
    runTmux(["new-session", "-d", "-s", sourceName, "-n", "authorized", sleepCommand]);
    runTmux(["new-window", "-d", "-t", `${sourceName}:`, "-n", "forbidden", sleepCommand]);
    sourceSessionId = runTmux(["display-message", "-p", "-t", sourceName, "#{session_id}"]);
    authorizedWindowId = runTmux([
      "display-message",
      "-p",
      "-t",
      `${sourceName}:authorized`,
      "#{window_id}",
    ]);
    authorizedPaneId = runTmux([
      "display-message",
      "-p",
      "-t",
      `${sourceName}:authorized`,
      "#{pane_id}",
    ]);
    forbiddenWindowId = runTmux([
      "display-message",
      "-p",
      "-t",
      `${sourceName}:forbidden`,
      "#{window_id}",
    ]);

    // Pin a distinctive durable-window option so the regression proves the
    // read-only view does not rewrite shared window state.
    runTmux(["set-option", "-w", "-t", `${sourceName}:authorized`, "window-size", "manual"]);
    sourceSessionOptions = runTmux(["show-options", "-t", sourceName]);
    sourceWindowOptions = runTmux(["show-options", "-w", "-t", `${sourceName}:authorized`]);
  });

  afterAll(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  });

  it("exposes only the authorized window and cleans up without mutating durable state", () => {
    const plan = planGroupedTmuxAttachment({
      attachmentId: "bc17014f-24ae-4a7b-bbab-d14db347efe6",
      generation: 0,
      target: {
        workspaceName: "workspace.live-regression",
        semanticPaneId: "pane.authorized",
      },
      viewerMode: "read-only",
      viewport: { cols: 120, rows: 40 },
      source: {
        sessionId: sourceSessionId,
        windowId: authorizedWindowId,
        runtimePaneId: authorizedPaneId,
        paneCount: 1,
      },
    });

    runPlan(plan.create.command);

    expect(runPlan(plan.recover.ownership.query)).toBe(plan.recover.ownership.expectedStdout);
    expect(runPlan(plan.recover.topology.query)).toBe(plan.recover.topology.expectedStdout);
    expect(
      runTmux([
        "list-windows",
        "-t",
        `=${plan.identity.viewSessionName}`,
        "-F",
        "#{window_id}",
      ]).split("\n"),
    ).toEqual([authorizedWindowId]);
    expect(() =>
      runTmux(["select-window", "-t", `${plan.identity.viewSessionName}:${forbiddenWindowId}`]),
    ).toThrow();

    expect(runTmux(["show-options", "-t", sourceName])).toBe(sourceSessionOptions);
    expect(runTmux(["show-options", "-w", "-t", `${sourceName}:authorized`])).toBe(
      sourceWindowOptions,
    );

    // Cleanup is deliberately executed only after the marker gate matches.
    expect(runPlan(plan.cleanup.ownership.query)).toBe(plan.cleanup.ownership.expectedStdout);
    runPlan(plan.cleanup.command);

    expect(() => runTmux(["has-session", "-t", `=${plan.identity.viewSessionName}`])).toThrow();
    expect(runTmux(["has-session", "-t", `=${sourceName}`])).toBe("");
    expect(
      runTmux(["list-windows", "-t", `=${sourceName}`, "-F", "#{window_id}"])
        .split("\n")
        .sort(),
    ).toEqual([authorizedWindowId, forbiddenWindowId].sort());
    expect(runTmux(["display-message", "-p", "-t", authorizedPaneId, "#{pane_dead}"])).toBe("0");
  });
});
