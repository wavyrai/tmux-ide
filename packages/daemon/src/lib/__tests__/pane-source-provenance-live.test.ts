import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import {
  DaemonEventServerFrameSchemaZ,
  type DaemonEventServerFrame,
  type InteractionReceipt,
} from "@tmux-ide/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { send } from "../../send.ts";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { PANE_SOURCE_CREDENTIAL_OPTION } from "../pane-source-credentials.ts";
import { INTERNAL_SEND_OPERATION_OPTION } from "../tmux-external-interaction-observer.ts";
import { _setDefaultWorkspaceRegistryForTests, WorkspaceRegistry } from "../workspace-registry.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux).sequential("authenticated pane provenance, full daemon", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-m56-provenance-"));
  const socketPath = join(root, "tmux.sock");
  const session = basename(root);
  const workspaceName = "workspace.m56-provenance";
  const ownerToken = `owner-${randomUUID()}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;
  let sourcePane = "";
  let targetPane = "";

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  beforeAll(() => {
    for (const name of [
      "TMUX",
      "TMUX_PANE",
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

    sourcePane = run([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      session,
      "-n",
      "work",
    ]);
    targetPane = run(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:0`]);
    run(["select-pane", "-t", sourcePane, "-T", "Editor"]);
    run(["select-pane", "-t", targetPane, "-T", "Tests"]);
    run(["set-option", "-p", "-t", sourcePane, "@ide_name", "Editor"]);
    run(["set-option", "-p", "-t", targetPane, "@ide_name", "Tests"]);
    run(["set-option", "-p", "-t", sourcePane, "@tmux_ide_pane_id", "pane.editor"]);
    run(["set-option", "-p", "-t", targetPane, "@tmux_ide_pane_id", "pane.tests"]);
    process.env.TMUX = `${socketPath},${process.pid},0`;
    process.env.TMUX_PANE = sourcePane;

    const registry = new WorkspaceRegistry({
      dir: join(root, "registry"),
      listSessions: () => [session],
    });
    registry.add({ name: workspaceName, sessionName: session, projectDir: root });
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

  const start = async (): Promise<EmbeddedDaemonHandle> => {
    const started = await startEmbeddedDaemon({
      sessionName: session,
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });
    handle = started;
    return started;
  };

  function eventClient(daemon: EmbeddedDaemonHandle) {
    const socket = new WebSocket(`${daemon.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const frames: DaemonEventServerFrame[] = [];
    const waiters = new Set<() => void>();
    socket.on("message", (data: unknown) => {
      const parsed = DaemonEventServerFrameSchemaZ.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      frames.push(parsed.data);
      for (const notify of [...waiters]) notify();
    });
    const waitFor = (
      predicate: (frame: DaemonEventServerFrame) => boolean,
      timeoutMs = 15_000,
    ): Promise<DaemonEventServerFrame> =>
      new Promise((resolve, reject) => {
        const check = () => {
          const frame = frames.find(predicate);
          if (!frame) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(frame);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error("timed out waiting for daemon event"));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    return { socket, frames, waitFor };
  }

  it("runs the real CLI send path, emits honest receipts, and rotates authority on restart", async () => {
    const first = await start();
    const events = eventClient(first);
    await new Promise<void>((resolve, reject) => {
      events.socket.once("open", resolve);
      events.socket.once("error", reject);
    });
    await events.waitFor((frame) => frame.type === "hello");

    const oldCredential = run([
      "display-message",
      "-p",
      "-t",
      sourcePane,
      `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
    ]).trim();
    expect(oldCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const marker = `M56_CLI_${randomUUID().slice(0, 8)}`;
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await send(root, { to: "Tests", message: `printf '${marker}\\n'` });
    } finally {
      consoleLog.mockRestore();
    }
    await vi.waitFor(() => {
      expect(run(["capture-pane", "-p", "-t", targetPane])).toContain(marker);
    });
    const observed = (await events.waitFor(
      (frame) =>
        frame.type === "interaction.receipt" &&
        frame.origin === "cli" &&
        frame.phase === "observed" &&
        frame.target.kind === "pane" &&
        frame.target.semanticPaneId === "pane.tests",
    )) as InteractionReceipt;
    expect(observed.sourceSemanticPaneId).toBe("pane.editor");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      events.frames.filter(
        (frame) =>
          frame.type === "interaction.receipt" &&
          frame.target.kind === "pane" &&
          frame.target.semanticPaneId === "pane.tests" &&
          frame.origin === "external" &&
          frame.operationKind === "workspace.pane.send",
      ),
    ).toHaveLength(0);

    // A forged/stale product marker is not consumed by SessionRuntime. It must
    // fall through as honest external activity instead of suppressing UI.
    run([
      "set-option",
      "-p",
      "-t",
      targetPane,
      INTERNAL_SEND_OPERATION_OPTION,
      `${first.instanceId}:${randomUUID()}`,
    ]);
    run(["send-keys", "-t", targetPane, "-l", "--", "printf 'EXTERNAL_M56\\n'"]);
    run(["send-keys", "-t", targetPane, "Enter"]);
    const external = (await events.waitFor(
      (frame) =>
        frame.type === "interaction.receipt" &&
        frame.origin === "external" &&
        frame.target.kind === "pane" &&
        frame.target.semanticPaneId === "pane.tests",
    )) as InteractionReceipt;
    expect(external).toMatchObject({ phase: "observed", sourceSemanticPaneId: null });

    events.socket.close();
    await first.stop({ gracefulMs: 500 });
    handle = null;
    expect(run(["has-session", "-t", session])).toBe("");

    const second = await start();
    const newCredential = run([
      "display-message",
      "-p",
      "-t",
      sourcePane,
      `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
    ]).trim();
    expect(newCredential).not.toBe(oldCredential);

    const staleMarker = `STALE_${randomUUID().slice(0, 8)}`;
    const response = await fetch(`${second.apiBaseUrl}/api/v2/action/workspace.pane.send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
        "X-Tmux-Ide-Pane-Source-Credential": oldCredential,
      },
      body: JSON.stringify({
        workspaceName,
        sourceSemanticPaneId: "pane.editor",
        semanticPaneId: "pane.tests",
        text: `printf '${staleMarker}\\n'`,
        submit: true,
        origin: "cli",
      }),
    });
    expect(await response.json()).toMatchObject({ ok: false });
    expect(run(["capture-pane", "-p", "-t", targetPane])).not.toContain(staleMarker);
    expect(run(["has-session", "-t", session])).toBe("");
  });
});
