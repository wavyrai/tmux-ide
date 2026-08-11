import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationShellResourceV3SchemaZ,
  WorkspaceMissionsEnvelopeV1SchemaZ,
} from "@tmux-ide/contracts";

import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { createApp } from "../server.ts";
import { initialApplicationShellAppWindows } from "../../lib/application-shell-app-windows.ts";

const OWNER = "mission-owner-capability";
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function setup() {
  const registryDir = mkdtempSync(join(tmpdir(), "mission-route-registry-"));
  const projectDir = mkdtempSync(join(tmpdir(), "mission-route-project-"));
  scratch.push(registryDir, projectDir);
  const registry = new WorkspaceRegistry({ dir: registryDir, listSessions: () => ["tmux-alpha"] });
  registry.add({
    name: "alpha",
    sessionName: "tmux-alpha",
    projectDir,
    configKind: "none",
    configPath: null,
    hasWorkspaceConfig: false,
  });
  const load = vi.fn(async () => ({
    status: "empty" as const,
    counts: { missions: 0, history: 0, activity: 0 },
    missions: [],
    history: [],
    activity: [],
    truncated: false,
  }));
  const loadSnapshot = vi.fn(async () => null);
  const inventory = vi.fn(async (sessionName: string) => ({
    name: sessionName,
    runtimeSessionId: "$1",
    dir: projectDir,
    catalogIssue: null,
    panes: [
      {
        runtimePaneId: "%1",
        semanticPaneId: "pane.editor",
        index: 0,
        title: "Editor",
        currentCommand: "claude",
        active: true,
        windowPaneCount: 1,
        role: "lead",
        name: "Editor",
        type: "agent",
      },
    ],
  }));
  const app = createApp({
    remoteAccess: { ownerToken: OWNER },
    workspaceRegistry: registry,
    applicationShellInventoryBackend: { discoverApplicationShellSession: inventory },
    applicationShellAppWindowBackend: {
      load: async (_dir, ids, focused) =>
        initialApplicationShellAppWindows(ids, focused, "2026-08-12T00:00:00.000Z"),
    },
    applicationShellMissionBackend: { load, loadSnapshot },
  });
  return { app, load, loadSnapshot, inventory };
}

const auth = { Authorization: `Bearer ${OWNER}` };

describe("lazy workspace missions resource", () => {
  it("does not touch mission authority during the terminal-first V3 shell read", async () => {
    const { app, load, loadSnapshot } = setup();
    const response = await app.request("/api/project/tmux-alpha/application-shell?version=3");
    expect(response.status).toBe(200);
    const shell = ApplicationShellResourceV3SchemaZ.parse(await response.json());
    expect(shell.resource.terminalInventory.resources).toHaveLength(1);
    expect(shell.resource.appWindows).toBeDefined();
    expect(shell.resource).not.toHaveProperty("missionWorkspace");
    expect(shell.resource).not.toHaveProperty("agentGraphOverlay");
    expect(load).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("requires owner authority and loads missions only on the lazy route", async () => {
    const { app, load, loadSnapshot, inventory } = setup();
    expect((await app.request("/api/project/alpha/missions")).status).toBe(401);

    const response = await app.request("/api/project/alpha/missions", { headers: auth });
    expect(response.status).toBe(200);
    const envelope = WorkspaceMissionsEnvelopeV1SchemaZ.parse(await response.json());
    expect(envelope.resource.workspaceName).toBe("alpha");
    expect(envelope.resource.missionWorkspace.status).toBe("empty");
    expect(load).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(inventory).toHaveBeenCalledWith("tmux-alpha");
    expect(JSON.stringify(envelope)).not.toMatch(/\$1|%1|mission-route-project/u);
  });

  it("returns a path-free degraded projection when mission verification fails", async () => {
    const { app, load } = setup();
    load.mockRejectedValueOnce(new Error("failed at /private/mission/state"));
    const response = await app.request("/api/project/alpha/missions", { headers: auth });
    expect(response.status).toBe(200);
    const envelope = WorkspaceMissionsEnvelopeV1SchemaZ.parse(await response.json());
    expect(envelope.resource.missionWorkspace).toEqual({
      status: "degraded",
      reason: "Mission history could not be verified. The terminal workspace remains available.",
    });
    expect(JSON.stringify(envelope)).not.toContain("/private/mission/state");
  });
});
