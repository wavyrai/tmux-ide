import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  ApplicationShellResourceV2SchemaZ,
  TERMINAL_ATTACHMENT_ISSUE_PATH,
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TerminalAttachmentIssueResultSchemaZ,
  WorkspaceOpenMutationResultSchemaZ,
} from "@tmux-ide/contracts";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { deriveWorkspaceOpenIdentity } from "../workspace-open.ts";
import { _setDefaultWorkspaceRegistryForTests, WorkspaceRegistry } from "../workspace-registry.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux).sequential("config-free workspace open isolated tmux integration", () => {
  const root = mkdtempSync(join("/tmp", "tmux-ide-open-live-"));
  const projectDir = join(root, "project");
  const aliasDir = join(root, "project-alias");
  const collisionProjectDir = join(root, "collision-project");
  const socketPath = join(root, "tmux.sock");
  const keeperSession = "workspace-open-keeper";
  const ownerToken = `owner-${randomUUID()}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;
  let registry: WorkspaceRegistry;

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  beforeAll(() => {
    mkdirSync(projectDir);
    mkdirSync(collisionProjectDir);
    symlinkSync(projectDir, aliasDir, "dir");
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

  it("opens, reopens through an alias, writes no project config, and attaches to the semantic shell", async () => {
    handle = await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });

    const dispatch = async (selectedDir: string, operationId: string) => {
      const response = await fetch(`${handle!.apiBaseUrl}/api/v2/action/workspace.open`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
          "X-Tmux-Ide-Operation-Id": operationId,
        },
        body: JSON.stringify({ projectDir: selectedDir }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        ok?: boolean;
        result?: unknown;
        error?: { code?: string };
      };
    };
    const open = async (selectedDir: string, operationId: string) => {
      const envelope = await dispatch(selectedDir, operationId);
      expect(envelope.ok).toBe(true);
      return WorkspaceOpenMutationResultSchemaZ.parse(envelope.result);
    };

    const createOperationId = randomUUID();
    const created = await open(projectDir, createOperationId);
    const replayed = await open(projectDir, createOperationId);
    const reopened = await open(aliasDir, randomUUID());
    expect(created.outcome).toBe("created");
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.resource).toEqual(created.resource);
    expect(reopened.outcome).toBe("reopened");
    expect(reopened.resource).toEqual(created.resource);
    expect(JSON.stringify(created)).not.toMatch(/projectDir|sessionName|runtime|tmux|socket/u);

    expect(existsSync(join(projectDir, "ide.yml"))).toBe(false);
    expect(existsSync(join(projectDir, ".tmux-ide"))).toBe(false);
    expect(registry.get(created.resource.workspaceName)).toMatchObject({
      projectDir: realpathSync(projectDir),
      configKind: "none",
      configPath: null,
      ideConfigPath: null,
      hasWorkspaceConfig: false,
    });

    const sessionInventory = run([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_id}\t#{@tmux_ide_workspace_name}",
    ]);
    const openedSession = sessionInventory
      .split("\n")
      .map((line) => line.split("\t"))
      .find((fields) => fields[2] === created.resource.workspaceName);
    expect(openedSession).toBeDefined();
    expect(openedSession?.[1]).toMatch(/^\$[0-9]+$/u);
    const canonicalSessionName = openedSession![0]!;
    const sessionId = openedSession![1]!;
    const initialPane = run([
      "list-panes",
      "-s",
      "-t",
      sessionId,
      "-F",
      "#{pane_id}\t#{window_id}\t#{window_name}\t#{window_panes}\t#{session_windows}\t#{@tmux_ide_pane_id}\t#{@tmux_ide_window_id}\t#{@ide_type}\t#{@ide_role}\t#{@ide_name}",
    ]).split("\t");
    expect(initialPane).toEqual([
      expect.stringMatching(/^%[0-9]+$/u),
      expect.stringMatching(/^@[0-9]+$/u),
      "Terminal",
      "1",
      "1",
      created.resource.initialPaneId,
      deriveWorkspaceOpenIdentity(realpathSync(projectDir)).initialWindowId,
      "shell",
      "shell",
      "Terminal",
    ]);

    const shellResponse = await fetch(
      `${handle.apiBaseUrl}/api/project/${encodeURIComponent(created.resource.workspaceName)}/application-shell?version=2`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(shellResponse.status).toBe(200);
    const shell = ApplicationShellResourceV2SchemaZ.parse(await shellResponse.json());
    expect(shell.resource.terminalInventory.resources).toEqual([
      expect.objectContaining({
        id: created.resource.initialPaneId,
        kind: "terminal",
        attachability: {
          status: "available",
          semanticPaneId: created.resource.initialPaneId,
        },
      }),
    ]);
    expect(JSON.stringify(shell.resource.terminalInventory)).not.toMatch(/[@%$][0-9]+/u);

    const registered = registry.get(created.resource.workspaceName)!;
    registry.remove(created.resource.workspaceName);
    expect((await dispatch(projectDir, createOperationId)).error?.code).toBe(
      "workspace_resource_changed",
    );
    registry.add({
      name: registered.name,
      sessionName: registered.sessionName,
      projectDir: registered.projectDir,
      ideConfigPath: null,
      configKind: "none",
      configPath: null,
      hasWorkspaceConfig: false,
    });
    expect((await open(projectDir, createOperationId)).outcome).toBe("replayed");

    registry.add({
      name: "later-alias-membership",
      sessionName: registered.sessionName,
      projectDir: registered.projectDir,
      ideConfigPath: null,
      configKind: "none",
      configPath: null,
      hasWorkspaceConfig: false,
    });
    expect((await dispatch(projectDir, createOperationId)).error?.code).toBe(
      "workspace_resource_changed",
    );
    const duplicatedMembershipResponse = await fetch(
      `${handle.apiBaseUrl}/api/project/${encodeURIComponent(created.resource.workspaceName)}/application-shell?version=2`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(duplicatedMembershipResponse.status).toBe(503);
    expect(await duplicatedMembershipResponse.json()).toEqual({
      error: "Session discovery unavailable",
    });
    registry.remove("later-alias-membership");
    expect((await open(projectDir, createOperationId)).outcome).toBe("replayed");

    const liveRegistryRecord = registry.get(created.resource.workspaceName)!;
    liveRegistryRecord.sessionName = keeperSession;
    expect((await dispatch(projectDir, createOperationId)).error?.code).toBe(
      "workspace_resource_changed",
    );
    liveRegistryRecord.sessionName = canonicalSessionName;

    run(["rename-session", "-t", sessionId, "renamed-config-free-workspace"]);
    expect((await dispatch(projectDir, createOperationId)).error?.code).toBe(
      "workspace_resource_changed",
    );
    run(["rename-session", "-t", sessionId, canonicalSessionName]);

    const splitPaneId = run([
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      initialPane[0]!,
    ]);
    expect((await dispatch(projectDir, createOperationId)).error?.code).toBe(
      "workspace_resource_changed",
    );
    run(["kill-pane", "-t", splitPaneId]);

    const [duplicatePaneId, duplicateWindowId] = run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}\t#{window_id}",
      "-t",
      sessionId,
      "-n",
      "Duplicate",
    ]).split("\t");
    for (const [option, value] of [
      ["@tmux_ide_pane_id", created.resource.initialPaneId],
      ["@ide_type", "shell"],
      ["@ide_role", "shell"],
      ["@ide_name", "Duplicate"],
    ] as const) {
      run(["set-option", "-p", "-t", duplicatePaneId!, option, value]);
    }
    expect((await dispatch(projectDir, createOperationId)).error?.code).toBe(
      "workspace_resource_changed",
    );
    run(["kill-window", "-t", duplicateWindowId!]);
    expect((await open(projectDir, createOperationId)).outcome).toBe("replayed");

    const collisionIdentity = deriveWorkspaceOpenIdentity(realpathSync(collisionProjectDir));
    run(["new-session", "-d", "-s", collisionIdentity.sessionName]);
    const collision = await dispatch(collisionProjectDir, randomUUID());
    expect(collision.ok).toBe(false);
    expect(collision.error?.code).toBe("session_conflict");
    expect(run(["has-session", "-t", `=${collisionIdentity.sessionName}`])).toBe("");
    run(["kill-session", "-t", `=${collisionIdentity.sessionName}`]);

    const requestId = randomUUID();
    const issueResponse = await fetch(`${handle.apiBaseUrl}${TERMINAL_ATTACHMENT_ISSUE_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        Origin: "tmux-ide://app",
        "X-Tmux-Ide-Expected-Daemon-Instance-Id": handle.instanceId,
        "X-Tmux-Ide-Request-Id": requestId,
      },
      body: JSON.stringify({
        requestId,
        expectedDaemonInstanceId: handle.instanceId,
        attachment: {
          protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
          target: {
            workspaceName: created.resource.workspaceName,
            semanticPaneId: created.resource.initialPaneId,
          },
          viewerMode: "interactive",
          viewport: { cols: 100, rows: 30 },
        },
      }),
    });
    const issue = TerminalAttachmentIssueResultSchemaZ.parse(await issueResponse.json());
    expect(issue.status).toBe("issued");
    if (issue.status !== "issued") throw new Error(issue.error.code);

    const socket = new WebSocket(issue.descriptor.webSocketUrl, issue.descriptor.subprotocol, {
      origin: "tmux-ide://app",
    });
    const ready = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("attachment did not become ready")), 5_000);
      socket.on("error", reject);
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const parsed = JSON.parse(data.toString()) as { type?: string };
        if (parsed.type !== "ready") return;
        clearTimeout(timeout);
        resolve(parsed);
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "redeem",
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        ticket: issue.descriptor.redemptionTicket,
        requestId,
        daemonInstanceId: handle.instanceId,
      }),
    );
    await expect(ready).resolves.toMatchObject({
      type: "ready",
      sourceGrid: { cols: expect.any(Number), rows: expect.any(Number) },
    });
    socket.close();
  }, 30_000);
});
