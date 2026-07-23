import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  ApplicationShellResourceV3SchemaZ,
  DaemonEventServerFrameSchemaZ,
  WorkspacePromoteMutationResultSchemaZ,
  type DaemonEventWorkspacePromotionCompletedFrame,
} from "@tmux-ide/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { _setDefaultWorkspaceRegistryForTests, WorkspaceRegistry } from "../workspace-registry.ts";
import { fleetSessionIdForName } from "../../command-center/resources/fleet-catalog.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux).sequential("workspace promotion isolated tmux integration", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-promote-live-"));
  const projectDir = join(root, "project");
  const socketPath = join(root, "tmux.sock");
  const keeperSession = "workspace-promote-keeper";
  const targetSession = `fleet-promote-${randomUUID().slice(0, 8)}`;
  const ownerToken = `owner-${randomUUID()}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;
  let registry: WorkspaceRegistry;

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  beforeAll(() => {
    mkdirSync(projectDir);
    for (const name of [
      "TMUX",
      "TMUX_IDE_DAEMON_INFO_DIR",
      "TMUX_IDE_REGISTRY_DIR",
      "TMUX_IDE_SETTINGS_DIR",
      "TMUX_IDE_HOME",
      "TMUX_IDE_SESSION",
    ]) {
      previousEnvironment[name] = process.env[name];
    }
    process.env.TMUX_IDE_DAEMON_INFO_DIR = join(root, "daemon");
    process.env.TMUX_IDE_REGISTRY_DIR = join(root, "registry");
    process.env.TMUX_IDE_SETTINGS_DIR = join(root, "settings");
    process.env.TMUX_IDE_HOME = join(root, "home");
    delete process.env.TMUX_IDE_SESSION;

    run(["-f", "/dev/null", "new-session", "-d", "-s", keeperSession, "exec sleep 300"]);
    process.env.TMUX = `${socketPath},${process.pid},0`;

    registry = new WorkspaceRegistry({
      dir: join(root, "registry"),
      listSessions: () => run(["list-sessions", "-F", "#{session_name}"]).split("\n"),
    });
    _setDefaultWorkspaceRegistryForTests(registry);
  });

  afterAll(async () => {
    await handle?.stop({ gracefulMs: 100 }).catch(() => undefined);
    handle = null;
    _setDefaultWorkspaceRegistryForTests(null);
    spawnSync(executablePath, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("promotes an adopted multi-window session and exposes honest per-pane attachability", async () => {
    handle = await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });

    // A real, arbitrary-topology adopted session the app did NOT create:
    // window 1 is a single-pane self-reporting agent; window 2 is a two-pane
    // split of plain shells.
    const agentPaneId = run([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      targetSession,
      "-c",
      projectDir,
      "-n",
      "agent",
      "exec sleep 300",
    ]);
    const nowSec = Math.floor(Date.now() / 1000);
    run(["set-option", "-p", "-t", agentPaneId, "@agent_state", `working:${nowSec}`]);
    run(["set-option", "-p", "-t", agentPaneId, "@agent_display_name", "Live Agent"]);
    const workPaneId = run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      `${targetSession}:`,
      "-c",
      projectDir,
      "-n",
      "work",
      "exec sleep 300",
    ]);
    run(["split-window", "-d", "-t", workPaneId, "-c", projectDir, "exec sleep 300"]);
    run(["set-option", "-t", targetSession, "@tmux_ide_adopted", "1"]);

    // A live /ws/events client observing the typed promotion receipts the
    // dispatcher emits alongside action.complete (m42/receipts).
    const receiptSocket = new WebSocket(`${handle.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const promotionReceipts: DaemonEventWorkspacePromotionCompletedFrame[] = [];
    receiptSocket.on("message", (data: unknown) => {
      const parsed = DaemonEventServerFrameSchemaZ.safeParse(
        JSON.parse(typeof data === "string" ? data : String(data)),
      );
      if (parsed.success && parsed.data.type === "workspace.promotion-completed") {
        promotionReceipts.push(parsed.data);
      }
    });
    await new Promise<void>((resolve, reject) => {
      receiptSocket.once("open", () => resolve());
      receiptSocket.once("error", reject);
    });
    const waitForReceiptCount = async (count: number): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (promotionReceipts.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`saw ${promotionReceipts.length}/${count} promotion receipts in 10s`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    const sessionId = fleetSessionIdForName(targetSession);
    const dispatch = async (operationId: string) => {
      const response = await fetch(`${handle!.apiBaseUrl}/api/v2/action/workspace.promote`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
          "X-Tmux-Ide-Operation-Id": operationId,
          Connection: "close",
        },
        body: JSON.stringify({ sessionId }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        ok?: boolean;
        result?: unknown;
        error?: { code?: string };
      };
    };
    const promote = async (operationId: string) => {
      const envelope = await dispatch(operationId);
      expect(envelope.ok).toBe(true);
      return WorkspacePromoteMutationResultSchemaZ.parse(envelope.result);
    };

    const firstOperation = randomUUID();
    const promoted = await promote(firstOperation);
    expect(promoted.outcome).toBe("promoted");
    const workspaceName = promoted.resource.workspaceName;
    // Wire audit: no filesystem path and no tmux runtime id crosses the wire.
    // The workspace name embeds the sanitized session basename — the same
    // identity the fleet catalog already exposes as a session `label` — so that
    // is the one allowed identity, exactly as m32 embeds the project basename.
    expect(JSON.stringify(promoted)).not.toContain(projectDir);
    expect(JSON.stringify(promoted)).not.toContain(realpathSync(projectDir));
    expect(JSON.stringify(promoted)).not.toMatch(/[$%@][0-9]+/u);

    // Registry-visible with the session cwd as its project dir.
    expect(registry.get(workspaceName)).toMatchObject({
      sessionName: targetSession,
      projectDir: realpathSync(projectDir),
      configKind: "none",
      configPath: null,
      ideConfigPath: null,
      hasWorkspaceConfig: false,
    });

    // Durable session stamps: workspace name + the DISTINCT promotion marker,
    // never the m32 open marker.
    const sessionStamps = run([
      "list-sessions",
      "-F",
      "#{session_name}\t#{@tmux_ide_workspace_name}\t#{@tmux_ide_workspace_promoted_v1}\t#{@tmux_ide_workspace_open_v1}",
    ])
      .split("\n")
      .map((line) => line.split("\t"))
      .find((fields) => fields[0] === targetSession);
    expect(sessionStamps).toEqual([targetSession, workspaceName, "1", ""]);

    // Every pane is stamped and every window carries a durable window id.
    const paneStamps = run([
      "list-panes",
      "-s",
      "-t",
      targetSession,
      "-F",
      "#{pane_id}\t#{@tmux_ide_pane_id}\t#{@tmux_ide_window_id}\t#{@ide_type}",
    ])
      .split("\n")
      .map((line) => line.split("\t"));
    expect(paneStamps).toHaveLength(3);
    for (const [, paneStamp, windowStamp] of paneStamps) {
      expect(paneStamp).toMatch(/^pane\.promoted\.[0-9a-f]{20}$/u);
      expect(windowStamp).toMatch(/^window\.promoted\.[0-9a-f]{20}$/u);
    }
    const agentStamp = paneStamps.find((fields) => fields[0] === agentPaneId)!;
    expect(agentStamp[3]).toBe("agent");

    // The V3 application-shell resolves the promoted session (keyed by its
    // session name) and reports honest per-pane attachability.
    const shellResponse = await fetch(
      `${handle.apiBaseUrl}/api/project/${encodeURIComponent(targetSession)}/application-shell?version=3`,
      { headers: { Authorization: `Bearer ${ownerToken}`, Connection: "close" } },
    );
    expect(shellResponse.status).toBe(200);
    const shell = ApplicationShellResourceV3SchemaZ.parse(await shellResponse.json());
    const resources = shell.resource.terminalInventory?.resources ?? [];
    expect(resources).toHaveLength(3);
    const available = resources.filter((entry) => entry.attachability.status === "available");
    // attach-4: every promoted pane is attachable. Promotion stamps the lone
    // agent window and the two-pane split window with distinct, unique durable
    // window stamps, so the window-capable projection flips all three panes to
    // available (no pane ever reports not-single-pane-window here again).
    expect(available).toHaveLength(3);
    // Each pane carries a wire-safe window grouping key minted from its window
    // stamp digest; the two split panes share ONE key, the agent window owns a
    // distinct one — so attaching two panes of the split window is a visible
    // shared-window conflict under attach-3's window-keyed ownership.
    const groupSizes = new Map<string, number>();
    for (const entry of resources) {
      expect(entry.windowResourceId).toMatch(/^terminal-window\.[0-9a-f]{20}$/u);
      const key = entry.windowResourceId!;
      groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
    }
    expect([...groupSizes.values()].sort()).toEqual([1, 2]);
    // Wire audit: neither a tmux runtime id nor the raw window stamp ever leaks.
    expect(JSON.stringify(shell.resource.terminalInventory)).not.toMatch(/[$%@][0-9]+/u);
    expect(JSON.stringify(shell.resource.terminalInventory)).not.toMatch(/window\.promoted\./u);

    // The open workspace's V3 resource carries its OWN opaque fleet session id
    // (m40/fleet-live gap 1), minted by the SAME authority the fleet catalog and
    // this promotion both use, so the renderer can mark this session open and
    // draw it exactly once. It is the opaque digest — never the raw session name.
    expect(shell.resource.fleetSessionId).toBe(sessionId);
    expect(shell.resource.fleetSessionId).toMatch(/^session\.[A-Za-z0-9_-]{16,64}$/u);
    expect(shell.resource.fleetSessionId).not.toContain(targetSession);

    // The typed receipt for the first promotion arrived on the push bus.
    await waitForReceiptCount(1);
    expect(promotionReceipts[0]).toMatchObject({
      type: "workspace.promotion-completed",
      workspaceName,
      outcome: "promoted",
    });
    expect(JSON.stringify(promotionReceipts[0])).not.toContain(projectDir);
    expect(JSON.stringify(promotionReceipts[0])).not.toMatch(/[$%@][0-9]+/u);

    // Re-promote under a fresh operation id, then under the same one: replayed.
    const rePromoted = await promote(randomUUID());
    expect(rePromoted.outcome).toBe("replayed");
    expect(rePromoted.resource.workspaceName).toBe(workspaceName);
    const replayed = await promote(firstOperation);
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.resource.workspaceName).toBe(workspaceName);

    // Each replay yields its own typed receipt with the honest outcome.
    await waitForReceiptCount(3);
    expect(promotionReceipts.slice(1).map((receipt) => receipt.outcome)).toEqual([
      "replayed",
      "replayed",
    ]);
    receiptSocket.close();

    // A non-owner request is refused by the host-capability gate.
    const unauthorized = await fetch(`${handle.apiBaseUrl}/api/v2/action/workspace.promote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
        Connection: "close",
      },
      body: JSON.stringify({ sessionId }),
    });
    expect(unauthorized.status).toBe(401);
  }, 45_000);

  it("promotes across dead pane cwds and fails typed only when nothing resolves", async () => {
    handle ??= await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });

    const liveDir = (label: string): string => {
      const dir = join(root, `live-${label}-${randomUUID().slice(0, 8)}`);
      mkdirSync(dir);
      return dir;
    };
    // A directory that exists at pane-creation time, then is pruned — exactly a
    // removed git worktree. tmux keeps reporting its (now dead) path as the
    // pane's cwd, so realpath fails on it.
    const prunedDir = (label: string): string => {
      const dir = join(root, `pruned-${label}-${randomUUID().slice(0, 8)}`);
      mkdirSync(dir);
      return dir;
    };

    const promoteEnvelope = async (
      sessionName: string,
    ): Promise<{
      ok?: boolean;
      result?: unknown;
      error?: { code?: string; details?: unknown };
    }> => {
      const response = await fetch(`${handle!.apiBaseUrl}/api/v2/action/workspace.promote`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
          "X-Tmux-Ide-Operation-Id": randomUUID(),
          Connection: "close",
        },
        body: JSON.stringify({ sessionId: fleetSessionIdForName(sessionName) }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    // (a) session_path lives, but the active pane's cwd is a pruned worktree.
    const liveA = liveDir("a");
    const deadA = prunedDir("a");
    const nameA = `promote-deadpane-${randomUUID().slice(0, 8)}`;
    run(["new-session", "-d", "-s", nameA, "-c", liveA, "-n", "editor", "exec sleep 300"]);
    run(["split-window", "-d", "-t", `${nameA}:`, "-c", deadA, "exec sleep 300"]);
    // Make the pruned-worktree pane the active one, then prune its directory.
    run(["select-pane", "-t", `${nameA}:editor.1`]);
    rmSync(deadA, { recursive: true, force: true });
    run(["set-option", "-t", nameA, "@tmux_ide_adopted", "1"]);

    const promotedA = await promoteEnvelope(nameA);
    expect(promotedA.ok).toBe(true);
    const resultA = WorkspacePromoteMutationResultSchemaZ.parse(promotedA.result);
    // Resolved from the live session_path, not the dead pane cwd.
    expect(registry.get(resultA.resource.workspaceName)?.projectDir).toBe(realpathSync(liveA));

    // (b) EVERY pane cwd is dead, but session_path still lives -> resolves via (a).
    const liveB = liveDir("b");
    const deadB = prunedDir("b");
    const nameB = `promote-alldeadpanes-${randomUUID().slice(0, 8)}`;
    run(["new-session", "-d", "-s", nameB, "-c", liveB, "-n", "keep", "exec sleep 300"]);
    // A second window whose only pane starts in the soon-to-be-pruned dir; then
    // drop the original window so no surviving pane has a live cwd.
    run(["new-window", "-d", "-t", `${nameB}:`, "-c", deadB, "-n", "dead", "exec sleep 300"]);
    run(["kill-window", "-t", `${nameB}:keep`]);
    rmSync(deadB, { recursive: true, force: true });
    run(["set-option", "-t", nameB, "@tmux_ide_adopted", "1"]);

    const promotedB = await promoteEnvelope(nameB);
    expect(promotedB.ok).toBe(true);
    const resultB = WorkspacePromoteMutationResultSchemaZ.parse(promotedB.result);
    expect(registry.get(resultB.resource.workspaceName)?.projectDir).toBe(realpathSync(liveB));

    // (c) session_path AND every pane cwd are dead -> typed verification failure.
    const deadRootC = prunedDir("c");
    const nameC = `promote-alldead-${randomUUID().slice(0, 8)}`;
    run(["new-session", "-d", "-s", nameC, "-c", deadRootC, "-n", "editor", "exec sleep 300"]);
    run(["set-option", "-t", nameC, "@tmux_ide_adopted", "1"]);
    rmSync(deadRootC, { recursive: true, force: true });

    const failedC = await promoteEnvelope(nameC);
    expect(failedC.ok).toBe(false);
    expect(failedC.error?.code).toBe("promotion_verification_failed");
    expect(failedC.error?.details).toMatchObject({ reason: "project_directory_unavailable" });
    // A resolution failure is harmless: the session is never admitted.
    expect(registry.list().some((workspace) => workspace.sessionName === nameC)).toBe(false);
  }, 45_000);
});
