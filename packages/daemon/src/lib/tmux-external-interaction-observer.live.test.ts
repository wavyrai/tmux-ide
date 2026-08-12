import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TmuxExternalInteractionObserver } from "./tmux-external-interaction-observer.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux).sequential("tmux external interaction observer live", () => {
  vi.setConfig({ testTimeout: 20_000 });
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      spawnSync("tmux", ["-S", join(root, "tmux.sock"), "kill-server"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes ordered markers without a child client and preserves user hooks", async () => {
    const root = mkdtempSync("/tmp/tmux-ide-native-hook-");
    roots.push(root);
    const socketPath = join(root, "tmux.sock");
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const run = (args: readonly string[]): string =>
      execFileSync(executablePath, ["-S", socketPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    run(["-f", "/dev/null", "new-session", "-d", "-s", "project", "cat"]);
    const pane = run(["display-message", "-p", "-t", "project", "#{pane_id}"]);
    run(["set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.editor"]);
    run(["set-hook", "-ag", "after-send-keys", "display-message user-hook"]);

    const daemonInstanceId = randomUUID();
    const observed: Array<string | null> = [];
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId,
      tmuxAuthority: { executablePath, socketSelector: { kind: "path", path: socketPath } },
      registry: {
        list: () => [{ name: "workspace.project", sessionName: "project", projectDir: root }],
      } as unknown as WorkspaceRegistry,
      onObserved: (interaction) => {
        observed.push(interaction.operationId);
        return interaction.operationId !== null;
      },
    });
    observer.start();
    const operationIds = Array.from({ length: 32 }, () => randomUUID());
    for (const operationId of operationIds) {
      run([
        "set-option",
        "-p",
        "-t",
        pane,
        "@tmux_ide_send_operation",
        `${daemonInstanceId}:${operationId}`,
        ";",
        "send-keys",
        "-t",
        pane,
        "-l",
        "x",
      ]);
    }
    run(["send-keys", "-t", pane, "-l", "z"]);
    await vi.waitFor(() => expect(observed).toHaveLength(operationIds.length + 1));
    expect(observed).toEqual([...operationIds, null]);

    await observer.dispose();
    expect(run(["show-hooks", "-g", "after-send-keys"])).toContain("user-hook");
    expect(run(["show-hooks", "-g", "after-send-keys"])).not.toContain(daemonInstanceId);
    expect(run(["list-buffers", "-F", "#{buffer_name}"])).not.toContain(daemonInstanceId);
  });
});
