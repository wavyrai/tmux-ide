import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  GROUPED_TMUX_VIEW_SESSION_PREFIX,
  planGroupedTmuxAttachment,
  type TmuxArgvPlan,
} from "../attachments/grouped-tmux.ts";
import {
  TmuxAttachmentViewExecutor,
  type TmuxAttachmentCommandResult,
  type TmuxAttachmentCommandRunner,
} from "../attachments/tmux-view-executor.ts";
import { PtyTmuxAttachmentLauncher } from "../attachments/pty-tmux-attachment-launcher.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `tmux-ide-executor-${process.pid}-${randomUUID().slice(0, 8)}`;
const sleepCommand = "exec sleep 2147483647";
const durableCommand = "exec sh -c 'printf authoritative-redraw; sleep 2147483647'";
const legacyPaneMarkerOption = "@tmux_ide_attachment_view";

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
      const result: TmuxAttachmentCommandResult = stderr.includes("unknown variable:")
        ? { status: "variable-not-found" }
        : /(?:can't find|no such|not found|no server running)/u.test(stderr)
          ? { status: "not-found" }
          : { status: "failed" };
      return result;
    }
  }
}

class DirectSocketRunner implements TmuxAttachmentCommandRunner {
  run(command: TmuxArgvPlan): TmuxAttachmentCommandResult {
    try {
      const stdout = execFileSync("tmux", [...command.argv], {
        encoding: "utf8",
        maxBuffer: 128 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: "ok", stdout };
    } catch (error) {
      const stderr = String((error as { stderr?: string | Buffer }).stderr ?? "").toLowerCase();
      return /(?:can't find|no such|not found|no server running)/u.test(stderr)
        ? { status: "not-found" }
        : { status: "failed" };
    }
  }
}

describe.skipIf(!hasTmux)("TmuxAttachmentViewExecutor live server guards", () => {
  const runner = new LiveSocketRunner();
  let sessionId = "";
  let windowId = "";
  let paneId = "";

  beforeAll(() => {
    runOnSocket(["new-session", "-d", "-s", "durable-source", "-n", "authorized", durableCommand]);
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

  function livePlan(attachmentId: string, viewerMode: "interactive" | "read-only" = "read-only") {
    return planGroupedTmuxAttachment({
      attachmentId,
      generation: 0,
      target: { workspaceName: "workspace.live", semanticPaneId: "pane.authorized" },
      viewerMode,
      viewport: { cols: 120, rows: 40 },
      source: { sessionId, windowId, runtimePaneId: paneId, paneCount: 1 },
    });
  }

  function liveOperation(
    selectedPlan: ReturnType<typeof livePlan>,
    operation: "create" | "attach" | "recover" = "create",
  ) {
    return {
      operation,
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
        GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      ),
    ).resolves.toContainEqual({
      viewSessionName: selectedPlan.identity.viewSessionName,
      markerValue: selectedPlan.identity.markerValue,
      windowIds: [windowId],
    });
    const cleanupResult = await executor.guardedCleanup({
      exactViewSessionTarget: `=${selectedPlan.identity.viewSessionName}`,
      markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      expectedMarkerValue: selectedPlan.identity.markerValue,
      expectedWindowId: windowId,
    });
    expect(cleanupResult).toBe("cleaned");
    expect(() =>
      runOnSocket(["has-session", "-t", `=${selectedPlan.identity.viewSessionName}`]),
    ).toThrow();
    expect(runOnSocket(["display-message", "-p", "-t", paneId, "#{pane_dead}"]).trim()).toBe("0");
  });

  it("does not accept a pane-only legacy option when the session marker is absent", async () => {
    const selectedPlan = livePlan("677b4096-7e25-43bb-a01d-3fa7d9b93ce8");
    const exactTarget = `=${selectedPlan.identity.viewSessionName}` as const;
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    await executor.executeGuardedViewOperation(liveOperation(selectedPlan));
    runOnSocket(["set-environment", "-u", "-t", exactTarget, GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT]);
    runOnSocket([
      "set-option",
      "-p",
      "-t",
      paneId,
      legacyPaneMarkerOption,
      selectedPlan.identity.markerValue,
    ]);

    await expect(
      executor.guardedCleanup({
        exactViewSessionTarget: exactTarget,
        markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
        expectedMarkerValue: selectedPlan.identity.markerValue,
        expectedWindowId: windowId,
      }),
    ).resolves.toBe("ownership-mismatch");
    expect(runOnSocket(["has-session", "-t", exactTarget])).toBe("");

    runOnSocket(["set-option", "-p", "-u", "-t", paneId, legacyPaneMarkerOption]);
    runOnSocket(["kill-session", "-t", exactTarget]);
  });

  it("treats an exact missing marker as unowned despite a marker-looking multiline value", async () => {
    const selectedPlan = livePlan("80805d88-9e3f-4d8e-99ae-0a16941e72e1");
    const exactTarget = `=${selectedPlan.identity.viewSessionName}` as const;
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    await executor.executeGuardedViewOperation(liveOperation(selectedPlan));
    runOnSocket(["set-environment", "-u", "-t", exactTarget, GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT]);
    runOnSocket([
      "set-environment",
      "-t",
      exactTarget,
      "UNRELATED_MULTILINE",
      `before\n${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}=${selectedPlan.identity.markerValue}\nafter`,
    ]);

    await expect(
      executor.enumerateMarkedViews(
        GROUPED_TMUX_VIEW_SESSION_PREFIX,
        GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      ),
    ).resolves.toContainEqual({
      viewSessionName: selectedPlan.identity.viewSessionName,
      markerValue: null,
      windowIds: [windowId],
    });
    await expect(
      executor.guardedCleanup({
        exactViewSessionTarget: exactTarget,
        markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
        expectedMarkerValue: selectedPlan.identity.markerValue,
        expectedWindowId: windowId,
      }),
    ).resolves.toBe("ownership-mismatch");
    expect(runOnSocket(["has-session", "-t", exactTarget])).toBe("");
    runOnSocket(["kill-session", "-t", exactTarget]);
  });

  it("recognizes the exact valid marker despite a conflicting multiline value", async () => {
    const selectedPlan = livePlan("0b3283cc-9e16-4d68-9ffd-dd1521e9c028");
    const exactTarget = `=${selectedPlan.identity.viewSessionName}` as const;
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    await executor.executeGuardedViewOperation(liveOperation(selectedPlan));
    runOnSocket([
      "set-environment",
      "-t",
      exactTarget,
      "UNRELATED_MULTILINE",
      `before\n${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}=v1:00000000-0000-4000-8000-000000000000:0\nafter`,
    ]);

    await expect(
      executor.enumerateMarkedViews(
        GROUPED_TMUX_VIEW_SESSION_PREFIX,
        GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      ),
    ).resolves.toContainEqual({
      viewSessionName: selectedPlan.identity.viewSessionName,
      markerValue: selectedPlan.identity.markerValue,
      windowIds: [windowId],
    });
    await expect(
      executor.guardedCleanup({
        exactViewSessionTarget: exactTarget,
        markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
        expectedMarkerValue: selectedPlan.identity.markerValue,
        expectedWindowId: windowId,
      }),
    ).resolves.toBe("cleaned");
  });

  it("uses the session environment marker despite a conflicting pane user option", async () => {
    const selectedPlan = livePlan("187efac9-a928-4ccb-bf71-10fb3c3cdf59");
    const exactTarget = `=${selectedPlan.identity.viewSessionName}` as const;
    const executor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    await executor.executeGuardedViewOperation(liveOperation(selectedPlan));
    runOnSocket([
      "set-option",
      "-p",
      "-t",
      paneId,
      legacyPaneMarkerOption,
      "conflicting-pane-value",
    ]);

    await expect(
      executor.guardedCleanup({
        exactViewSessionTarget: exactTarget,
        markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
        expectedMarkerValue: selectedPlan.identity.markerValue,
        expectedWindowId: windowId,
      }),
    ).resolves.toBe("cleaned");
    runOnSocket(["set-option", "-p", "-u", "-t", paneId, legacyPaneMarkerOption]);
  });

  it("attaches a normal real PTY client, redraws and resizes, then detaches without killing durable truth", async () => {
    const selectedPlan = livePlan("2fd6f699-416f-4258-b5f2-0bd9933e8f50", "interactive");
    const exactTarget = `=${selectedPlan.identity.viewSessionName}` as const;
    const prepareExecutor = new TmuxAttachmentViewExecutor({ runner, now: () => 1_000 });
    await prepareExecutor.executeGuardedViewOperation(liveOperation(selectedPlan));

    const transport = new PtyTmuxAttachmentLauncher({
      socketSelector: { kind: "name", name: socketName },
      trustedCwd: process.cwd(),
      proofRunner: new DirectSocketRunner(),
      environment: process.env,
      readinessTimeoutMs: 5_000,
    });
    const executor = new TmuxAttachmentViewExecutor({
      runner,
      clientTransport: transport,
      now: () => 1_000,
    });
    const executed = await executor.executeGuardedViewOperation(
      liveOperation(selectedPlan, "attach"),
    );
    expect(executed).toMatchObject({ status: "executed", clientClaim: expect.any(Object) });
    if (typeof executed === "string") throw new Error("expected a client claim");
    const client = transport.claim(executed.clientClaim)!;
    expect(client).not.toBeNull();
    expect(runOnSocket(["list-windows", "-t", exactTarget, "-F", "#{window_id}"]).trim()).toBe(
      windowId,
    );
    expect(runOnSocket(["list-panes", "-t", exactTarget, "-F", "#{pane_id}"]).trim()).toBe(paneId);
    const redraw: Buffer[] = [];
    const detachData = client.onData((data) => redraw.push(data));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Buffer.concat(redraw).toString("utf8")).toContain("authoritative-redraw");
    expect(client).not.toHaveProperty("write");
    expect(client.boundedInput?.write(Buffer.from("bounded-input"))).toMatchObject({
      status: "accepted",
      byteLength: 13,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runOnSocket(["capture-pane", "-p", "-t", paneId])).toContain("bounded-input");
    client.resize(100, 30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      runOnSocket([
        "list-clients",
        "-t",
        exactTarget,
        "-F",
        "#{client_width}x#{client_height}",
      ]).trim(),
    ).toBe("100x30");
    detachData();
    client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runOnSocket(["has-session", "-t", exactTarget])).toBe("");
    expect(runOnSocket(["display-message", "-p", "-t", paneId, "#{pane_dead}"]).trim()).toBe("0");

    await expect(
      executor.guardedCleanup({
        exactViewSessionTarget: exactTarget,
        markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
        expectedMarkerValue: selectedPlan.identity.markerValue,
        expectedWindowId: windowId,
      }),
    ).resolves.toBe("cleaned");
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
