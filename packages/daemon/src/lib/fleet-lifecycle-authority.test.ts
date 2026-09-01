import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "@tmux-ide/contracts";
import type { FleetSessionFacts } from "../command-center/discovery.ts";
import {
  fleetCatalogRevisionForFacts,
  fleetSessionIdForName,
} from "../command-center/resources/fleet-catalog.ts";

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
      if (args[0] === "new-session") {
        const sessionFlag = args.indexOf("-s");
        const sessionName = sessionFlag < 0 ? undefined : args[sessionFlag + 1];
        if (sessionName) liveSessions.add(sessionName);
      }
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
    expect(calls[0]).toEqual([
      "new-session",
      "-d",
      "-e",
      "COLORTERM=truecolor",
      "-s",
      result.workspaceName,
      "-n",
      "workspace",
      "-c",
      canonicalCwd,
      'exec env -u NO_COLOR COLORTERM=truecolor "${SHELL:-/bin/sh}" -l',
    ]);
    expect(calls).toContainEqual([
      "set-environment",
      "-r",
      "-t",
      `=${result.workspaceName}`,
      "NO_COLOR",
    ]);
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

  it("fails closed when canonical fleet observation is unavailable", async () => {
    const cwd = root();
    const calls: string[][] = [];
    const authority = new FleetLifecycleAuthority({
      daemonInstanceId: GENERATION,
      productVersion: "2.8.0",
      startedAt: "2026-08-13T00:00:00.000Z",
      registry: { list: () => [], add: () => undefined as never },
      readFleet: () => null,
      runTmux: (args) => {
        calls.push([...args]);
        return "";
      },
    });

    await expect(
      authority.provisionAgent(OPERATION, GENERATION, {
        expectedCatalogRevision: fleetCatalogRevisionForFacts([]),
        command: "claude",
        harness: "claude",
        displayTitle: "Claude",
        target: { kind: "new-session", displayName: "Review", cwd },
      }),
    ).rejects.toMatchObject({ code: "fleet_unavailable" });
    expect(calls).toEqual([]);
  });

  it("serializes revision-fenced provisioning and stamps only through its pinned runner", async () => {
    const cwd = root();
    const workspaces: Workspace[] = [
      {
        name: "demo",
        sessionName: "demo",
        projectDir: cwd,
        ideConfigPath: null,
        configKind: "none",
        configPath: null,
        hasWorkspaceConfig: false,
        addedAt: "2026-08-13T00:00:00.000Z",
      },
    ];
    const calls: string[][] = [];
    const panes: FleetSessionFacts["panes"][number][] = [
      {
        runtimePaneId: "%1",
        semanticPaneId: "pane.editor",
        incarnation: 101,
        active: true,
        currentCommand: "zsh",
        currentPath: cwd,
        agentStateRaw: null,
        agentStatusTextRaw: null,
        agentDisplayNameRaw: null,
        agentHintRaw: null,
      },
    ];
    const facts = (): FleetSessionFacts[] => [
      { name: "demo", appCreated: true, cwd, panes: [...panes] },
    ];
    let nextPane = 2;
    let pendingPane: string | null = null;
    const authority = new FleetLifecycleAuthority({
      daemonInstanceId: GENERATION,
      productVersion: "2.8.0",
      startedAt: "2026-08-13T00:00:00.000Z",
      registry: { list: () => [...workspaces], add: () => workspaces[0]! },
      readFleet: facts,
      runTmux: (args) => {
        calls.push([...args]);
        if (args[0] === "split-window" || args[0] === "new-window") {
          pendingPane = `%${nextPane++}`;
          panes.push({
            ...panes[0]!,
            runtimePaneId: pendingPane,
            semanticPaneId: null,
            incarnation: 100 + nextPane,
            currentCommand: "claude",
            active: false,
          });
          return pendingPane;
        }
        if (args[0] === "set-option" && args.at(-2) === "@tmux_ide_pane_id") {
          const pane = panes.find((item) => item.runtimePaneId === args[3]);
          if (pane) (pane as { semanticPaneId: string | null }).semanticPaneId = args.at(-1)!;
        }
        if (args[0] === "has-session" && args[2] === "=_tmux-ide-chrome") return "";
        return "";
      },
    });
    const revision = fleetCatalogRevisionForFacts(facts());
    const input = {
      expectedCatalogRevision: revision,
      command: "claude",
      harness: "claude",
      displayTitle: "Claude",
      target: {
        kind: "existing-session" as const,
        fleetSessionId: fleetSessionIdForName("demo"),
        placement: "split-h" as const,
        targetSemanticPaneId: "pane.editor",
        cwd: null,
        inheritTargetCwd: true,
      },
    };
    const first = authority.provisionAgent(OPERATION, GENERATION, input);
    const second = authority.provisionAgent(
      "a2ff8da4-b66e-4684-8296-86e12d0e11b7",
      GENERATION,
      input,
    );
    await expect(first).resolves.toMatchObject({ outcome: "created" });
    await expect(second).rejects.toMatchObject({ code: "catalog_changed" });
    expect(calls).toContainEqual([
      "split-window",
      "-h",
      "-t",
      "%1",
      "-P",
      "-F",
      "#{pane_id}",
      "-e",
      "COLORTERM=truecolor",
      "-c",
      cwd,
      "env -u NO_COLOR COLORTERM=truecolor claude",
    ]);
    expect(calls).toContainEqual(["set-environment", "-r", "-t", "=demo", "NO_COLOR"]);
    expect(calls).toContainEqual(["set-environment", "-t", "=demo", "COLORTERM", "truecolor"]);
    expect(calls.some((args) => args.includes("@tmux_ide_pane_id"))).toBe(true);
    expect(panes).toHaveLength(2);
  });

  it("rolls back a fresh session without persisting registry intent when decoration fails", async () => {
    const cwd = root();
    const workspaces: Workspace[] = [];
    const calls: string[][] = [];
    const authority = new FleetLifecycleAuthority({
      daemonInstanceId: GENERATION,
      productVersion: "2.8.0",
      startedAt: "2026-08-13T00:00:00.000Z",
      registry: {
        list: () => [...workspaces],
        add: (input) => {
          const workspace = { ...input, addedAt: "2026-08-13T00:00:00.000Z" } as Workspace;
          workspaces.push(workspace);
          return workspace;
        },
      },
      readFleet: () => [],
      runTmux: (args) => {
        calls.push([...args]);
        if (args[0] === "new-session" && args.includes("-P")) return "%9";
        if (args.includes("@agent_launch")) throw new Error("decoration failed");
        return "";
      },
    });
    await expect(
      authority.provisionAgent(OPERATION, GENERATION, {
        expectedCatalogRevision: fleetCatalogRevisionForFacts([]),
        command: "claude",
        harness: "claude",
        displayTitle: "Claude",
        target: { kind: "new-session", displayName: "Review", cwd },
      }),
    ).rejects.toThrow("decoration failed");
    expect(workspaces).toEqual([]);
    expect(calls.find((args) => args[0] === "new-session")).toEqual([
      "new-session",
      "-d",
      "-e",
      "COLORTERM=truecolor",
      "-s",
      expect.stringMatching(/^review-/u),
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      realpathSync(cwd),
      "env -u NO_COLOR COLORTERM=truecolor claude",
    ]);
    expect(calls).toContainEqual(["kill-session", "-t", expect.stringMatching(/^review-/u)]);
  });
});
