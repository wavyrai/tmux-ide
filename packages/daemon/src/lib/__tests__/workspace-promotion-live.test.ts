import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  ApplicationShellResourceV3SchemaZ,
  WorkspacePromoteMutationResultSchemaZ,
} from "@tmux-ide/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

    // Re-promote under a fresh operation id, then under the same one: replayed.
    const rePromoted = await promote(randomUUID());
    expect(rePromoted.outcome).toBe("replayed");
    expect(rePromoted.resource.workspaceName).toBe(workspaceName);
    const replayed = await promote(firstOperation);
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.resource.workspaceName).toBe(workspaceName);

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
});
