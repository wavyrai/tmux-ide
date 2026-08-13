import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "@tmux-ide/contracts";

import {
  FleetLifecycleAuthority,
  FleetLifecycleAuthorityError,
} from "./fleet-lifecycle-authority.ts";

const GENERATION = "3f1c9a2e-6d4b-4a1c-8e2f-0a1b2c3d4e5f";
const OPERATION = "31dbe843-d1e8-42e6-b6d3-d994d9d3f5be";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "tmux-ide-fleet-lifecycle-"));
  roots.push(value);
  return value;
}

function rig() {
  const workspaces: Workspace[] = [];
  const calls: string[][] = [];
  const liveSessions = new Set<string>();
  const authority = new FleetLifecycleAuthority({
    daemonInstanceId: GENERATION,
    productVersion: "2.8.0",
    startedAt: "2026-08-13T00:00:00.000Z",
    registry: {
      list: () => [...workspaces],
      add: (input) => {
        const workspace: Workspace = {
          name: input.name,
          sessionName: input.sessionName ?? input.name,
          projectDir: input.projectDir,
          ideConfigPath: input.ideConfigPath ?? null,
          configKind: input.configKind,
          configPath: input.configPath,
          hasWorkspaceConfig: input.hasWorkspaceConfig,
          addedAt: "2026-08-13T00:00:00.000Z",
        };
        workspaces.push(workspace);
        return workspace;
      },
    },
    // This is the daemon-generation-pinned runner seam. No default-socket
    // executable exists in this test, so any ambient `tmux` call would fail.
    runTmux: (args) => {
      calls.push([...args]);
      if (args[0] === "new-session" && args[3]) liveSessions.add(args[3]);
      if (args[0] === "has-session") {
        const target = args[2]?.replace(/^=/u, "");
        if (!target || !liveSessions.has(target)) throw new Error("session absent");
      }
      return "";
    },
  });
  return { authority, calls, workspaces, liveSessions };
}

describe("FleetLifecycleAuthority", () => {
  it("creates and registers one canonical route through only the pinned runner", async () => {
    const cwd = root();
    const canonicalCwd = realpathSync(cwd);
    const { authority, calls, workspaces } = rig();
    const result = await authority.createSession(OPERATION, GENERATION, {
      displayName: "Review Team",
      cwd,
    });

    expect(result.outcome).toBe("created");
    expect(result.workspaceName).toMatch(/^review-team-[0-9a-f]{20}$/u);
    expect(workspaces).toEqual([
      expect.objectContaining({
        name: result.workspaceName,
        sessionName: result.workspaceName,
        projectDir: canonicalCwd,
      }),
    ]);
    expect(calls[0]).toEqual(["new-session", "-d", "-s", result.workspaceName, "-c", canonicalCwd]);
    expect(calls).toContainEqual([
      "new-session",
      "-d",
      "-s",
      "_tmux-ide-chrome",
      "exec tmux-ide chrome-updater",
    ]);
  });

  it("replays without a second mutation and rejects conflicting operation reuse", async () => {
    const cwd = root();
    const { authority, calls } = rig();
    const input = { displayName: "Review Team", cwd };
    const first = await authority.createSession(OPERATION, GENERATION, input);
    const callCount = calls.length;
    const replay = await authority.createSession(OPERATION, GENERATION, input);
    expect(replay).toEqual({ ...first, outcome: "replayed" });
    expect(calls).toHaveLength(callCount);
    await expect(
      authority.createSession(OPERATION, GENERATION, { displayName: "Different", cwd }),
    ).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it("adopts a proven live registry route and recreates the same route when tmux is gone", async () => {
    const cwd = root();
    const { authority, calls, liveSessions } = rig();
    const input = { displayName: "Review Team", cwd };
    const created = await authority.createSession(OPERATION, GENERATION, input);
    const adopted = await authority.createSession(
      "a2ff8da4-b66e-4684-8296-86e12d0e11b7",
      GENERATION,
      input,
    );
    expect(adopted).toMatchObject({ outcome: "adopted", workspaceName: created.workspaceName });
    const beforeRecreate = calls.filter((args) => args[0] === "new-session").length;
    liveSessions.delete(created.workspaceName);
    const reopened = await authority.createSession(
      "94791d66-a6fa-40bc-8188-b79de71f238e",
      GENERATION,
      input,
    );
    expect(reopened).toMatchObject({ outcome: "created", workspaceName: created.workspaceName });
    expect(calls.filter((args) => args[0] === "new-session")).toHaveLength(beforeRecreate + 1);
  });

  it("rejects stale generations, relative paths, and non-directories before tmux", async () => {
    const cwd = root();
    const file = join(cwd, "file");
    writeFileSync(file, "x");
    const { authority, calls } = rig();
    await expect(
      authority.createSession(OPERATION, "00000000-0000-4000-8000-000000000000", {
        displayName: "Review",
        cwd,
      }),
    ).rejects.toBeInstanceOf(FleetLifecycleAuthorityError);
    await expect(
      authority.createSession(OPERATION, GENERATION, { displayName: "Review", cwd: "relative" }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      authority.createSession(OPERATION, GENERATION, { displayName: "Review", cwd: file }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(calls).toEqual([]);
  });
});
