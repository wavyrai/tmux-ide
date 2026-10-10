import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createNativeTmuxServerOwner } from "./tmux-server-owner.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

it.skipIf(!hasTmux)(
  "resolves the live pane directory without changing the terminal",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "editor-context-")));
    const initial = join(root, "folder with spaces 界");
    const changed = join(root, "changed folder");
    const literal = join(root, "literal\\folder");
    mkdirSync(literal);
    mkdirSync(initial);
    mkdirSync(changed);
    const socket = join(root, "tmux.sock");
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const env = { ...process.env, HOME: root, TMUX: "", TMUX_PANE: "" };
    const run = (...args: string[]) =>
      execFileSync(executablePath, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env,
        timeout: 5000,
      }).trimEnd();
    let owner: Awaited<ReturnType<typeof createNativeTmuxServerOwner>> | undefined;
    const cleanup = async () => {
      const failures: unknown[] = [];
      try {
        await owner?.dispose();
      } catch (error) {
        failures.push(error);
      }
      const stopped = spawnSync(executablePath, ["-S", socket, "kill-server"], {
        env,
        stdio: "ignore",
        timeout: 5000,
      });
      if (stopped.error) failures.push(stopped.error);
      else rmSync(root, { recursive: true, force: true });
      if (failures.length) throw new AggregateError(failures, "Editor fixture cleanup failed");
    };
    try {
      run("new-session", "-d", "-s", "editor-test", "-c", initial, "/bin/sh");
      run("set-option", "-p", "-t", "editor-test:0.0", "@tmux_ide_pane_id", "pane.editor");
      run("set-option", "-w", "-t", "editor-test:0", "@tmux_ide_window_id", "window.editor");
      owner = await createNativeTmuxServerOwner({
        environmentId: randomUUID(),
        serverId: `tmux-server.${"d".repeat(32)}`,
        generation: randomUUID(),
        tmuxAuthority: { executablePath, socketSelector: { kind: "path", path: socket } },
        stateDirectory: join(root, "state"),
        webSocketUrl: "ws://127.0.0.1:45678/v2/terminal/pane-streams/redeem",
      });
      const session = (await owner.catalog()).find((row) => row.sessionName === "editor-test")!;
      const workspace = owner.workspaceRegistry
        .list()
        .find((row) => row.sessionName === "editor-test")!;
      const target = {
        generation: owner.generation,
        workspaceName: workspace.name,
        liveSessionId: session.liveSessionId!,
        semanticPaneId: "pane.editor",
      };
      const capture = () => run("capture-pane", "-p", "-t", "editor-test:0.0");
      const before = capture();
      const first = await owner.resolvePaneEditorContext(target);
      expect(first.directory).toBe(initial);
      expect(capture()).toBe(before);
      await expect(
        owner.resolvePaneEditorContext({ ...target, generation: randomUUID() }),
      ).rejects.toThrow();
      expect(capture()).toBe(before);

      // Change only the owned shell's live cwd. A stored project/layout cwd must not win.
      run("send-keys", "-t", "editor-test:0.0", "-l", `cd '${changed.replaceAll("'", "'\\''")}'`);
      run("send-keys", "-t", "editor-test:0.0", "Enter");
      await vi.waitFor(() =>
        expect(run("display-message", "-p", "-t", "editor-test:0.0", "#{pane_current_path}")).toBe(
          changed,
        ),
      );
      const afterCd = capture();
      expect((await owner.resolvePaneEditorContext(target)).directory).toBe(changed);
      expect(capture()).toBe(afterCd);
      run("send-keys", "-t", "editor-test:0.0", "-l", `cd '${literal}'`);
      run("send-keys", "-t", "editor-test:0.0", "Enter");
      await vi.waitFor(() =>
        expect(run("display-message", "-p", "-t", "editor-test:0.0", "#{pane_current_path}")).toBe(
          literal,
        ),
      );
      const afterLiteral = capture();
      expect((await owner.resolvePaneEditorContext(target)).directory).toBe(literal);
      expect(capture()).toBe(afterLiteral);
      await owner.dispose();
      await expect(owner.resolvePaneEditorContext(target)).rejects.toThrow();
      expect(run("display-message", "-p", "-t", "editor-test:0.0", "#{pane_current_path}")).toBe(
        literal,
      );
      expect(capture()).toBe(afterLiteral);
    } finally {
      await cleanup();
    }
  },
  30_000,
);
