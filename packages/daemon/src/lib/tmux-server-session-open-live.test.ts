import { createTmuxSessionMutationFence } from "./tmux-session-mutation-fence.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTmuxServerOwner, type NativeTmuxServerOwner } from "./tmux-server-owner.ts";
import { createNativeTmuxSessionOpener } from "./tmux-server-session-open.ts";
import { createServerGenerationFencedTmuxAsyncRunner } from "./tmux-server-generation-runner.ts";
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
describe.skipIf(!hasTmux).sequential("scoped ordinary session admission", () => {
  const root = mkdtempSync("/tmp/tmux-open-");
  const socket = join(root, "socket");
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const authority = { executablePath, socketSelector: { kind: "path" as const, path: socket } };
  const run = (args: string[]) =>
    execFileSync(executablePath, ["-S", socket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: { ...process.env, TMUX: "" },
    }).trim();
  let owner: NativeTmuxServerOwner;
  afterAll(async () => {
    await owner?.dispose();
    spawnSync(executablePath, ["-S", socket, "kill-server"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });
  it("opens an unstamped ordinary session and retains healthy IDs on repeated opens", async () => {
    run(["new-session", "-d", "-s", "ordinary", "exec sleep 300"]);
    owner = await createNativeTmuxServerOwner({
      serverId: `tmux-server.${"a".repeat(32)}`,
      generation: randomUUID(),
      tmuxAuthority: authority,
      stateDirectory: join(root, "state"),
      webSocketUrl: "ws://127.0.0.1:12345/v2/terminal/pane-streams/redeem",
    });
    const session = (await owner.catalog())[0]!;
    expect(run(["display-message", "-p", "-t", "ordinary", "#{@tmux_ide_pane_id}"])).toBe("");
    const opened = await owner.openSession(session.liveSessionId);
    expect(opened).toEqual({ liveSessionId: session.liveSessionId, workspaceName: "ordinary" });
    const stamps = run([
      "display-message",
      "-p",
      "-t",
      "ordinary",
      "#{@tmux_ide_pane_id}\t#{@tmux_ide_window_id}",
    ]);
    expect(stamps).not.toBe("");
    const inventory =
      await owner.terminalInventoryRuntime.discoverTerminalRuntimeSession("ordinary");
    expect(inventory).not.toBeNull();
    expect(inventory!.panes.length).toBe(1);
    await owner.openSession(session.liveSessionId);
    expect(
      run([
        "display-message",
        "-p",
        "-t",
        "ordinary",
        "#{@tmux_ide_pane_id}\t#{@tmux_ide_window_id}",
      ]),
    ).toBe(stamps);
  }, 20000);
  it("refuses replacement between selection validation and the first stamping command", async () => {
    run(["new-session", "-d", "-s", "race", "exec sleep 300"]);
    const selected = (await owner.catalog()).find((s) => s.sessionName === "race")!;
    const [pid, startTime] = run(["display-message", "-p", "#{pid}\t#{start_time}"]).split("\t");
    const nativeRun = createServerGenerationFencedTmuxAsyncRunner(authority, {
      pid: pid!,
      startTime: startTime!,
    });
    let replaced = false;
    const opener = createNativeTmuxSessionOpener({
      generation: owner.generation,
      registry: owner.workspaceRegistry,
      assertOpen() {},
      run: async (args) => {
        if (args[0] === "if-shell" && !replaced) {
          replaced = true;
          run(["kill-session", "-t", "race"]);
          run(["new-session", "-d", "-s", "race", "exec sleep 300"]);
        }
        return nativeRun(args);
      },
    });
    try {
      await expect(opener.openSession(selected.liveSessionId)).rejects.toThrow();
    } finally {
      await opener.dispose();
    }
    expect(replaced).toBe(true);
    expect(run(["display-message", "-p", "-t", "race", "#{@tmux_ide_pane_id}"])).toBe("");
    await expect(owner.openSession(selected.liveSessionId)).rejects.toThrow("no longer available");
  }, 15000);
  it("fences mutation after native session replacement and leaves unscoped IO unchanged", async () => {
    const selected = (await owner.catalog()).find((entry) => entry.sessionName === "race")!;
    const fence = createTmuxSessionMutationFence();
    const guarded = fence.wrap((args) => run([...args]));
    await expect(
      fence.execute({
        liveSessionId: selected.liveSessionId,
        sessionName: "race",
        run: async (args) => run([...args]),
        mutate: async () => {
          run(["kill-session", "-t", "race"]);
          run(["new-session", "-d", "-s", "race", "-n", "untouched", "exec sleep 300"]);
          guarded(["rename-window", "-t", "race:0", "wrong"]);
        },
      }),
    ).rejects.toThrow();
    expect(run(["display-message", "-p", "-t", "race:0", "#{window_name}"])).toBe("untouched");
    expect(guarded(["display-message", "-p", "-t", "race:0", "#{window_name}"])).toBe("untouched");
  });
  it("creates a new window only in the selected live session", async () => {
    const selected = (await owner.catalog()).find((entry) => entry.sessionName === "ordinary")!;
    const before = run(["list-windows", "-t", "ordinary", "-F", "#{window_id}"]).split("\n").length;
    const result = await owner.createSessionPane(selected.liveSessionId, {
      operationId: randomUUID(),
      expectedDaemonInstanceId: owner.generation,
      intent: { workspaceName: "ordinary", kind: "terminal", placement: { kind: "window" } },
    });
    expect(result.daemonInstanceId).toBe(owner.generation);
    expect(run(["list-windows", "-t", "ordinary", "-F", "#{window_id}"]).split("\n")).toHaveLength(
      before + 1,
    );
    const other = (await owner.catalog()).find((entry) => entry.sessionName === "race")!;
    await expect(
      owner.createSessionPane(other.liveSessionId, {
        operationId: randomUUID(),
        expectedDaemonInstanceId: owner.generation,
        intent: { workspaceName: "ordinary", kind: "terminal", placement: { kind: "window" } },
      }),
    ).rejects.toThrow("no longer available");
    expect(run(["list-windows", "-t", "ordinary", "-F", "#{window_id}"]).split("\n")).toHaveLength(
      before + 1,
    );
  }, 15000);
  it("creates a session on the explicit online owner with replay and no chrome process", async () => {
    run(["set-environment", "-g", "SHELL", "/bin/sh"]);
    const operationId = randomUUID();
    const input = {
      displayName: "Created here",
      cwd: root,
      expectedDaemonInstanceId: owner.generation,
    };
    const created = await owner.createSession(operationId, input);
    expect(created.outcome).toBe("created");
    expect(created.daemonInstanceId).toBe(owner.generation);
    expect(owner.workspaceRegistry.get(created.workspaceName)).toBeTruthy();
    expect((await owner.createSession(operationId, input)).outcome).toBe("replayed");
    expect(run(["list-sessions", "-F", "#{session_name}"])).not.toContain("_tmux-ide-chrome");
    await expect(async () =>
      owner.createSession(randomUUID(), { ...input, expectedDaemonInstanceId: randomUUID() }),
    ).rejects.toThrow("generation changed");
  }, 15000);
  it("refuses a same-name replacement even while the original session remains alive", async () => {
    run(["new-session", "-d", "-s", "rename-race", "-n", "before", "exec sleep 300"]);
    const selected = (await owner.catalog()).find((entry) => entry.sessionName === "rename-race")!;
    const fence = createTmuxSessionMutationFence();
    const guarded = fence.wrap((args) => run([...args]));
    await expect(
      fence.execute({
        liveSessionId: selected.liveSessionId,
        sessionName: "rename-race",
        run: async (args) => run([...args]),
        mutate: async () => {
          run(["rename-session", "-t", "rename-race", "original-retained"]);
          run(["new-session", "-d", "-s", "rename-race", "-n", "replacement", "exec sleep 300"]);
          guarded(["rename-window", "-t", "rename-race:0", "wrong"]);
        },
      }),
    ).rejects.toThrow("changed before mutation");
    expect(run(["display-message", "-p", "-t", "rename-race:0", "#{window_name}"])).toBe(
      "replacement",
    );
    expect(run(["display-message", "-p", "-t", "original-retained:0", "#{window_name}"])).toBe(
      "before",
    );
  });
});
