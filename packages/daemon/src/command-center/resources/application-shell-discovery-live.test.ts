import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { discoverWorkspaceRegistryTerminalInventory } from "../../terminal/attachments/native-runtime.ts";
import type { TmuxAttachmentCommandRunner } from "../../terminal/attachments/tmux-view-executor.ts";
import { projectApplicationShellResource } from "./application-shell.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const tmuxExecutable = hasTmux
  ? realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim())
  : "/usr/bin/false";
const socketName = `tmux-ide-inventory-${process.pid}-${randomUUID().slice(0, 8)}`;
const sessionName = "inventory-live";
const workspaceName = "workspace.inventory-live";
const sleepCommand = "exec sleep 2147483647";
const registryRoot = mkdtempSync(join(tmpdir(), "tmux-ide-inventory-live-"));

function runTmux(args: readonly string[]): string {
  return execFileSync(tmuxExecutable, ["-L", socketName, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe.skipIf(!hasTmux)("application-shell pinned all-window discovery", () => {
  let registry!: WorkspaceRegistry;
  let legacyPane = "";
  let runtimePaneIds: string[] = [];

  beforeAll(async () => {
    runTmux(["new-session", "-d", "-s", sessionName, "-n", "agent", sleepCommand]);
    runTmux(["new-window", "-d", "-t", `=${sessionName}:`, "-n", "legacy", sleepCommand]);
    runTmux(["new-window", "-d", "-t", `=${sessionName}:`, "-n", "split", sleepCommand]);
    runTmux(["split-window", "-d", "-t", `=${sessionName}:split`, sleepCommand]);

    const agentPane = runTmux([
      "display-message",
      "-p",
      "-t",
      `=${sessionName}:agent`,
      "#{pane_id}",
    ]);
    legacyPane = runTmux(["display-message", "-p", "-t", `=${sessionName}:legacy`, "#{pane_id}"]);
    const splitPanes = runTmux([
      "list-panes",
      "-t",
      `=${sessionName}:split`,
      "-F",
      "#{pane_id}",
    ]).split("\n");
    runtimePaneIds = [agentPane, legacyPane, ...splitPanes];

    runTmux(["set-option", "-p", "-t", agentPane, "@tmux_ide_pane_id", "pane.live-agent"]);
    runTmux(["set-option", "-p", "-t", agentPane, "@ide_type", "agent"]);
    runTmux(["set-option", "-p", "-t", agentPane, "@ide_name", "Codex"]);
    runTmux(["set-option", "-p", "-t", legacyPane, "@tmux_ide_pane_id", "pane.live-shell"]);
    splitPanes.forEach((paneId, index) =>
      runTmux([
        "set-option",
        "-p",
        "-t",
        paneId,
        "@tmux_ide_pane_id",
        `pane.live-split-${index + 1}`,
      ]),
    );
    runTmux(["select-window", "-t", `=${sessionName}:legacy`]);

    registry = new WorkspaceRegistry({
      dir: join(registryRoot, "registry"),
      listSessions: () => [sessionName],
    });
    registry.add({ name: workspaceName, sessionName, projectDir: registryRoot });
  });

  afterAll(() => {
    spawnSync(tmuxExecutable, ["-L", socketName, "kill-server"], { stdio: "ignore" });
    rmSync(registryRoot, { recursive: true, force: true });
  });

  const runner: TmuxAttachmentCommandRunner = {
    run(command) {
      try {
        return {
          status: "ok",
          stdout: execFileSync(tmuxExecutable, ["-L", socketName, ...command.argv], {
            cwd: registryRoot,
            encoding: "utf8",
            env: { TERM: "xterm-256color", LANG: "C" },
            maxBuffer: 128 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        };
      } catch {
        return { status: "failed" };
      }
    },
  };

  async function sessionSnapshot() {
    const inventory = await discoverWorkspaceRegistryTerminalInventory(registry, runner);
    const panes = inventory.panes.filter((pane) => pane.workspaceName === workspaceName);
    const first = panes[0]!;
    const catalogIssue = inventory.catalog.invalidRuntimeProof
      ? ("invalid-runtime-proof" as const)
      : inventory.catalog.missingSemanticStamp
        ? ("missing-semantic-stamp" as const)
        : inventory.catalog.duplicateSemanticStamp
          ? ("duplicate-semantic-stamp" as const)
          : inventory.catalog.duplicateRuntimePaneBinding
            ? ("duplicate-runtime-pane-binding" as const)
            : null;
    return {
      name: sessionName,
      runtimeSessionId: first.sessionId,
      dir: first.dir,
      catalogIssue,
      panes: panes.map(
        ({
          workspaceName: _workspaceName,
          sessionName: _sessionName,
          sessionId: _sessionId,
          sessionWindowCount: _sessionWindowCount,
          dir: _dir,
          ...pane
        }) => pane,
      ),
    };
  }

  it("uses stable semantic inventory while keeping raw tmux identities private", async () => {
    const first = await sessionSnapshot();
    const second = await sessionSnapshot();
    expect(first.panes).toHaveLength(4);
    expect(first.catalogIssue).toBeNull();

    const projected = projectApplicationShellResource(first);
    const refreshed = projectApplicationShellResource(second);
    expect(projected.terminalInventory.resources.map(({ id }) => id)).toEqual(
      refreshed.terminalInventory.resources.map(({ id }) => id),
    );
    expect(projected.terminalInventory.resources.map(({ attachability }) => attachability)).toEqual(
      expect.arrayContaining([
        { status: "available", semanticPaneId: "pane.live-agent" },
        { status: "available", semanticPaneId: "pane.live-shell" },
        { status: "unavailable", reason: "not-single-pane-window" },
      ]),
    );
    const encoded = JSON.stringify(projected.terminalInventory);
    for (const runtimePaneId of runtimePaneIds) expect(encoded).not.toContain(runtimePaneId);
    expect(encoded).not.toMatch(/[@%][0-9]+/u);
    expect(encoded).not.toContain(first.dir);
    expect(encoded).not.toContain("sleep");
  });

  it("makes every resource unavailable when any global pane is unstamped", async () => {
    runTmux(["set-option", "-p", "-t", legacyPane, "@tmux_ide_pane_id", ""]);
    const snapshot = await sessionSnapshot();
    expect(snapshot.catalogIssue).toBe("missing-semantic-stamp");
    const projected = projectApplicationShellResource(snapshot);
    expect(
      projected.terminalInventory.resources.every(
        ({ attachability }) =>
          attachability.status === "unavailable" &&
          attachability.reason === "missing-semantic-stamp",
      ),
    ).toBe(true);
  });
});
