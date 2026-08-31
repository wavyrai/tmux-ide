import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createPinnedWorkspaceTmuxRunner } from "./workspace-pane-creation.ts";
import { readWorkspaceRegistrySessionInventory, WorkspaceRegistry } from "./workspace-registry.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux).sequential("workspace registry tmux authority", () => {
  const root = mkdtempSync(join("/tmp", "tmux-ide-registry-authority-"));
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const unrelatedDefaultSocket = join(root, "default.sock");
  const privateSocket = join(root, "private.sock");
  const registryDir = join(root, "registry");
  const workspaceName = "same-name-workspace";

  const run = (socketPath: string, args: readonly string[]): string =>
    execFileSync(executablePath, ["-S", socketPath, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: { ...process.env, TMUX: "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  afterAll(() => {
    for (const socketPath of [privateSocket, unrelatedDefaultSocket]) {
      spawnSync(executablePath, ["-S", socketPath, "kill-server"], {
        env: { ...process.env, TMUX: "" },
        stdio: "ignore",
      });
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("never substitutes an unrelated server and fences a same-path reincarnation", async () => {
    // Both authorities deliberately contain the same session name. Reading an
    // ambient/default server would therefore look plausible while silently
    // reconciling against the wrong tmux universe.
    run(unrelatedDefaultSocket, ["new-session", "-d", "-s", workspaceName, "exec sleep 300"]);
    run(privateSocket, ["new-session", "-d", "-s", workspaceName, "exec sleep 300"]);

    const registry = new WorkspaceRegistry({ dir: registryDir, listSessions: () => [] });
    await registry.load();
    registry.add({
      name: workspaceName,
      sessionName: workspaceName,
      projectDir: root,
    });

    const originalRunner = createPinnedWorkspaceTmuxRunner({
      executablePath,
      socketSelector: { kind: "path", path: privateSocket },
    });
    await expect(
      registry.load(() => readWorkspaceRegistrySessionInventory(originalRunner)),
    ).resolves.toEqual({
      status: "authoritative",
      sessions: [workspaceName],
      removed: [],
    });

    // Losing the private server must not fall through to the unrelated server,
    // even though it advertises the same session name.
    run(privateSocket, ["kill-server"]);
    expect(readWorkspaceRegistrySessionInventory(originalRunner)).toMatchObject({
      status: "unavailable",
    });
    await expect(
      registry.load(() => readWorkspaceRegistrySessionInventory(originalRunner)),
    ).resolves.toEqual({ status: "preserved", reason: "unavailable" });
    expect(registry.has(workspaceName)).toBe(true);

    // A new server can reuse both socket path and session name. The old daemon
    // generation is inode-fenced and must preserve, never adopt, that server.
    run(privateSocket, ["new-session", "-d", "-s", workspaceName, "exec sleep 300"]);
    run(privateSocket, ["new-session", "-d", "-s", "replacement-keeper", "exec sleep 300"]);
    expect(readWorkspaceRegistrySessionInventory(originalRunner)).toMatchObject({
      status: "ambiguous",
      detail: expect.stringMatching(/socket authority changed/u),
    });
    await expect(
      registry.load(() => readWorkspaceRegistrySessionInventory(originalRunner)),
    ).resolves.toEqual({ status: "preserved", reason: "ambiguous" });
    expect(registry.has(workspaceName)).toBe(true);

    // A new daemon generation may pin the replacement. Once that exact server
    // authoritatively reports the workspace absent, cleanup is safe.
    const replacementRunner = createPinnedWorkspaceTmuxRunner({
      executablePath,
      socketSelector: { kind: "path", path: privateSocket },
    });
    run(privateSocket, ["kill-session", "-t", `=${workspaceName}`]);
    await expect(
      registry.load(() => readWorkspaceRegistrySessionInventory(replacementRunner)),
    ).resolves.toEqual({
      status: "authoritative",
      sessions: ["replacement-keeper"],
      removed: [workspaceName],
    });
    expect(registry.has(workspaceName)).toBe(false);
    expect(run(unrelatedDefaultSocket, ["has-session", "-t", `=${workspaceName}`])).toBe("");
  });
});
