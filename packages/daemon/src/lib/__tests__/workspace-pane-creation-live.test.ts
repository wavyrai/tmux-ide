import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { WorkspacePaneCreationAuthority } from "../workspace-pane-creation.ts";
import { WorkspaceRegistry } from "../workspace-registry.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `tmux-ide-pane-create-${process.pid}-${randomUUID().slice(0, 8)}`;
const sessionName = "native-create-live";
const daemonInstanceId = "20000000-0000-4000-8000-000000000002";
const operationId = "10000000-0000-4000-8000-000000000001";

describe.skipIf(!hasTmux)("workspace pane creation live tmux boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-pane-create-live-"));
  const proofPath = join(root, "argv-proof");
  const commandInjectionPath = join(root, "command-injected");
  const titleInjectionPath = join(root, "title-injected");
  const calls: string[][] = [];

  function runOnSocket(args: readonly string[]): string {
    calls.push([...args]);
    return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");
  }

  beforeAll(() => {
    runOnSocket(["new-session", "-d", "-s", sessionName, "exec sleep 30"]);
  });

  afterAll(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves hostile argv boundaries and uses raw exact runtime ids internally", async () => {
    const registry = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
    registry.add({ name: "workspace.live", sessionName, projectDir: root });
    const title = "Agent ; $(touch title-injected) #{pane_id}";
    const authority = new WorkspacePaneCreationAuthority({
      daemonInstanceId,
      registry,
      io: {
        canonicalProjectDir: () => root,
        runTmux: runOnSocket,
        isMissingTmuxTarget: () => false,
        creationFailureCannotHaveMutated: () => false,
        resolveHarness: async () => ({
          id: "portable-agent",
          label: "Portable Agent",
          command: [
            "/bin/sh",
            "-c",
            `printf '%s\\n%s' "$1" "$2" > '${proofPath}'; sleep 30`,
            "marker",
            "one two",
            `$(touch ${commandInjectionPath})`,
          ],
          environment: { TMUX_IDE_LIVE_PROOF: "present" },
        }),
      },
    });

    const result = await authority.create({
      operationId,
      expectedDaemonInstanceId: daemonInstanceId,
      intent: {
        kind: "agent",
        workspaceName: "workspace.live",
        displayTitle: title,
        harnessProfileId: "portable-agent",
        role: "implementer",
      },
    });

    await vi.waitFor(() => expect(existsSync(proofPath)).toBe(true));
    expect(readFileSync(proofPath, "utf8")).toBe(`one two\n$(touch ${commandInjectionPath})`);
    expect(existsSync(commandInjectionPath)).toBe(false);
    expect(existsSync(titleInjectionPath)).toBe(false);
    expect(result).toMatchObject({
      outcome: "created",
      resource: {
        workspaceName: "workspace.live",
        kind: "agent",
        displayTitle: title,
        harnessProfileId: "portable-agent",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/paneId|windowId|sessionName|cwd|argv|env/u);

    const createCall = calls.find((call) => call[0] === "new-window")!;
    expect(createCall.at(-1)).toContain("'one two'");
    expect(createCall.at(-1)).toContain(`'$(touch ${commandInjectionPath})'`);
    const runtimeTargetCalls = calls.filter(
      (call) =>
        ["set-option", "display-message", "rename-window"].includes(call[0] ?? "") &&
        call.includes("-t"),
    );
    expect(runtimeTargetCalls.length).toBeGreaterThan(0);
    for (const call of runtimeTargetCalls) {
      const target = call[call.indexOf("-t") + 1]!;
      if (target.startsWith("%") || target.startsWith("@")) {
        expect(target.startsWith("=")).toBe(false);
      }
    }

    const createdWindow = runOnSocket([
      "list-windows",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{window_name}",
    ])
      .split("\n")
      .find((name) => name === title);
    expect(createdWindow).toBe(title);
  });

  it("retires a live-success operation after its exact tmux window closes", async () => {
    const registry = new WorkspaceRegistry({
      dir: join(root, "retire-registry"),
      listSessions: () => [],
    });
    registry.add({ name: "workspace.retire", sessionName, projectDir: root });
    const authority = new WorkspacePaneCreationAuthority({
      daemonInstanceId,
      registry,
      maxLiveOrUnsafeOperations: 1,
      io: {
        canonicalProjectDir: () => root,
        runTmux: runOnSocket,
        isMissingTmuxTarget: (error) =>
          String((error as { stderr?: unknown }).stderr ?? error).includes("can't find"),
        creationFailureCannotHaveMutated: () => false,
      },
    });
    const firstOperation = "40000000-0000-4000-8000-000000000004";
    await authority.create({
      operationId: firstOperation,
      expectedDaemonInstanceId: daemonInstanceId,
      intent: { kind: "terminal", workspaceName: "workspace.retire" },
    });
    const ownedWindow = runOnSocket([
      "list-panes",
      "-s",
      "-t",
      `=${sessionName}`,
      "-F",
      "#{window_id}\t#{@tmux_ide_creation_id}",
    ])
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, marker]) => marker === firstOperation)?.[0];
    expect(ownedWindow).toMatch(/^@[0-9]+$/u);
    runOnSocket(["kill-window", "-t", ownedWindow!]);

    await expect(
      authority.create({
        operationId: "50000000-0000-4000-8000-000000000005",
        expectedDaemonInstanceId: daemonInstanceId,
        intent: { kind: "terminal", workspaceName: "workspace.retire" },
      }),
    ).resolves.toMatchObject({ outcome: "created" });
  });

  it("uses a daemon-pinned absolute tmux executable and socket after ambient env changes", async () => {
    const registry = new WorkspaceRegistry({
      dir: join(root, "pinned-registry"),
      listSessions: () => [],
    });
    registry.add({ name: "workspace.pinned", sessionName, projectDir: root });
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const socketPath = realpathSync(runOnSocket(["display-message", "-p", "#{socket_path}"]));
    const authority = new WorkspacePaneCreationAuthority({
      daemonInstanceId,
      registry,
      tmuxAuthority: { executablePath, socketSelector: { kind: "path", path: socketPath } },
    });
    const originalPath = process.env.PATH;
    const originalTmux = process.env.TMUX;
    process.env.PATH = "/definitely-not-a-real-path";
    process.env.TMUX = "/tmp/hostile-tmux.sock,999,9";
    try {
      await expect(
        authority.create({
          operationId: "60000000-0000-4000-8000-000000000006",
          expectedDaemonInstanceId: daemonInstanceId,
          intent: {
            kind: "terminal",
            workspaceName: "workspace.pinned",
            displayTitle: "Pinned authority",
          },
        }),
      ).resolves.toMatchObject({ outcome: "created" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = originalTmux;
    }
    expect(
      runOnSocket(["list-windows", "-t", `=${sessionName}`, "-F", "#{window_name}"]),
    ).toContain("Pinned authority");
  });
});
