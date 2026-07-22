import type { Workspace, WorkspaceOpenMutationRequest } from "@tmux-ide/contracts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  deriveWorkspaceOpenIdentity,
  WorkspaceOpenAuthority,
  WorkspaceOpenError,
  type WorkspaceOpenIo,
} from "../workspace-open.ts";

const DAEMON = "20000000-0000-4000-8000-000000000002";
const OPERATION = "10000000-0000-4000-8000-000000000001";
const CANONICAL_ROOT = "/canonical/project";

function request(
  overrides: Partial<WorkspaceOpenMutationRequest> = {},
): WorkspaceOpenMutationRequest {
  return {
    operationId: OPERATION,
    expectedDaemonInstanceId: DAEMON,
    intent: { projectDir: "/selected/project" },
    ...overrides,
  };
}

class MemoryRegistry {
  readonly workspaces: Workspace[];

  constructor(seed: Workspace[] = []) {
    this.workspaces = [...seed];
  }

  list(): Workspace[] {
    return [...this.workspaces];
  }

  get(name: string): Workspace | null {
    return this.workspaces.find((workspace) => workspace.name === name) ?? null;
  }

  add(input: {
    name: string;
    sessionName?: string;
    projectDir: string;
    ideConfigPath?: string | null;
    configKind?: "workspace" | "legacy" | "none";
    configPath?: string | null;
    hasWorkspaceConfig?: boolean;
  }): Workspace {
    if (this.get(input.name)) throw new Error("duplicate");
    const workspace: Workspace = {
      name: input.name,
      sessionName: input.sessionName ?? input.name,
      projectDir: input.projectDir,
      ideConfigPath: input.ideConfigPath ?? null,
      configKind: input.configKind,
      configPath: input.configPath,
      hasWorkspaceConfig: input.hasWorkspaceConfig,
      addedAt: "2026-07-22T00:00:00.000Z",
    };
    this.workspaces.push(workspace);
    return workspace;
  }
}

interface FakeSession {
  name: string;
  id: string;
  paneId: string;
  windowId: string;
  options: Map<string, string>;
  paneOptions: Map<string, string>;
  windowOptions: Map<string, string>;
  title: string;
  paneCount: number;
  extraPanes: Array<{
    paneId: string;
    windowId: string;
    title: string;
    paneOptions: Map<string, string>;
    windowOptions: Map<string, string>;
  }>;
}

class FakeTmux {
  readonly calls: string[][] = [];
  session: FakeSession | null = null;
  creations = 0;
  failOption: string | null = null;
  racedIdentity: ReturnType<typeof deriveWorkspaceOpenIdentity> | null = null;

  install(identity: ReturnType<typeof deriveWorkspaceOpenIdentity>): void {
    this.session = {
      name: identity.sessionName,
      id: "$9",
      paneId: "%9",
      windowId: "@9",
      options: new Map([
        ["@tmux_ide_workspace_open_v1", identity.projectKey],
        ["@tmux_ide_workspace_name", identity.workspaceName],
        ["@tmux_ide_workspace_open_operation", "external-operation"],
      ]),
      paneOptions: new Map([
        ["@tmux_ide_pane_id", identity.initialPaneId],
        ["@ide_type", "shell"],
        ["@ide_role", "shell"],
        ["@ide_name", "Terminal"],
      ]),
      windowOptions: new Map([["@tmux_ide_window_id", identity.initialWindowId]]),
      title: "Terminal",
      paneCount: 1,
      extraPanes: [],
    };
  }

  run = (input: readonly string[]): string => {
    const args = [...input];
    this.calls.push(args);
    switch (args[0]) {
      case "list-sessions":
        if (!this.session) return "";
        return [
          this.session.name,
          this.session.id,
          this.session.options.get("@tmux_ide_workspace_open_v1") ?? "",
          this.session.options.get("@tmux_ide_workspace_name") ?? "",
          this.session.options.get("@tmux_ide_workspace_open_operation") ?? "",
        ].join("\t");
      case "new-session": {
        if (this.session) throw new Error("duplicate session");
        if (this.racedIdentity) {
          this.install(this.racedIdentity);
          throw new Error("duplicate session after compatible winner");
        }
        this.creations += 1;
        this.session = {
          name: args[args.indexOf("-s") + 1]!,
          id: `$${this.creations}`,
          paneId: `%${this.creations}`,
          windowId: `@${this.creations}`,
          options: new Map(),
          paneOptions: new Map(),
          windowOptions: new Map(),
          title: "Terminal",
          paneCount: 1,
          extraPanes: [],
        };
        return `${this.session.id}\t${this.session.paneId}\t${this.session.windowId}`;
      }
      case "set-option": {
        if (!this.session) throw new Error("missing target");
        const option = args.at(-2)!;
        if (option === this.failOption) throw new Error("injected option failure");
        const value = args.at(-1)!;
        const options = args.includes("-p")
          ? this.session.paneOptions
          : args.includes("-w")
            ? this.session.windowOptions
            : this.session.options;
        options.set(option, value);
        return "";
      }
      case "select-pane":
        if (!this.session) throw new Error("missing target");
        this.session.title = args.at(-1)!;
        return "";
      case "list-panes": {
        if (!this.session) throw new Error("missing target");
        if (args.at(-1) === "#{session_id}\t#{pane_id}") {
          const lines = [`${this.session.id}\t${this.session.paneId}`];
          if (this.session.paneCount > 1) lines.push(`${this.session.id}\t%99`);
          for (const pane of this.session.extraPanes) {
            lines.push(`${this.session.id}\t${pane.paneId}`);
          }
          return lines.join("\n");
        }
        const windowCount = 1 + new Set(this.session.extraPanes.map((pane) => pane.windowId)).size;
        const row = (
          paneId: string,
          windowId: string,
          title: string,
          windowPaneCount: number,
          paneOptions: Map<string, string>,
          windowOptions: Map<string, string>,
        ): string =>
          [
            this.session!.name,
            this.session!.id,
            windowId,
            title,
            String(windowPaneCount),
            String(windowCount),
            paneId,
            paneOptions.get("@tmux_ide_pane_id") ?? "",
            windowOptions.get("@tmux_ide_window_id") ?? "",
            paneOptions.get("@ide_type") ?? "",
            paneOptions.get("@ide_role") ?? "",
            paneOptions.get("@ide_name") ?? "",
          ].join("\t");
        const lines = [
          row(
            this.session.paneId,
            this.session.windowId,
            this.session.title,
            this.session.paneCount,
            this.session.paneOptions,
            this.session.windowOptions,
          ),
        ];
        if (this.session.paneCount > 1) {
          lines.push(
            row(
              "%99",
              this.session.windowId,
              this.session.title,
              this.session.paneCount,
              new Map(),
              this.session.windowOptions,
            ),
          );
        }
        for (const pane of this.session.extraPanes) {
          const paneCount = this.session.extraPanes.filter(
            (candidate) => candidate.windowId === pane.windowId,
          ).length;
          lines.push(
            row(
              pane.paneId,
              pane.windowId,
              pane.title,
              paneCount,
              pane.paneOptions,
              pane.windowOptions,
            ),
          );
        }
        return lines.join("\n");
      }
      case "kill-session":
        if (!this.session || args.at(-1) !== this.session.id) throw new Error("missing target");
        this.session = null;
        return "";
      default:
        throw new Error(`unexpected tmux command: ${String(args[0])}`);
    }
  };
}

function rig(
  options: {
    canonicalRoot?: string;
    registry?: MemoryRegistry;
    tmux?: FakeTmux;
  } = {},
) {
  const canonicalRoot = options.canonicalRoot ?? CANONICAL_ROOT;
  const registry = options.registry ?? new MemoryRegistry();
  const tmux = options.tmux ?? new FakeTmux();
  const io: WorkspaceOpenIo = {
    resolveConfigFreeProjectDir: async () => canonicalRoot,
    canonicalRegisteredProjectDir: (path) => path,
    runTmux: tmux.run,
    isMissingTmuxTarget: (error) => (error as Error).message.includes("missing"),
    isTmuxUnavailable: () => false,
  };
  const authority = new WorkspaceOpenAuthority({
    daemonInstanceId: DAEMON,
    registry,
    io,
  });
  return { authority, registry, tmux, identity: deriveWorkspaceOpenIdentity(canonicalRoot) };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof WorkspaceOpenError ? error.code : undefined;
}

describe("WorkspaceOpenAuthority", () => {
  it("creates one stamped shell workspace, registers configKind none, and returns no runtime facts", async () => {
    const { authority, registry, tmux, identity } = rig();
    const result = await authority.open(request());

    expect(result).toEqual({
      operationId: OPERATION,
      daemonInstanceId: DAEMON,
      outcome: "created",
      resource: {
        resourceVersion: 1,
        workspaceName: identity.workspaceName,
        initialPaneId: identity.initialPaneId,
      },
    });
    expect(registry.workspaces).toEqual([
      expect.objectContaining({
        name: identity.workspaceName,
        sessionName: identity.sessionName,
        projectDir: CANONICAL_ROOT,
        ideConfigPath: null,
        configKind: "none",
        configPath: null,
        hasWorkspaceConfig: false,
      }),
    ]);
    expect(tmux.calls.find((call) => call[0] === "new-session")).toEqual([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_id}\t#{pane_id}\t#{window_id}",
      "-s",
      identity.sessionName,
      "-c",
      CANONICAL_ROOT,
      "-n",
      "Terminal",
    ]);
    expect(tmux.session?.options.get("@tmux_ide_workspace_open_operation")).toBe(OPERATION);
    expect(tmux.session?.paneOptions.get("@tmux_ide_pane_id")).toBe(identity.initialPaneId);
    expect(tmux.session?.windowOptions.get("@tmux_ide_window_id")).toBe(identity.initialWindowId);
    expect(JSON.stringify(result)).not.toMatch(/projectDir|sessionName|runtime|tmux|%1|\$1/u);
  });

  it("replays the same operation and idempotently reopens with another operation", async () => {
    const { authority, tmux } = rig();
    const created = await authority.open(request());
    const replayed = await authority.open(request());
    const reopened = await authority.open(
      request({ operationId: "30000000-0000-4000-8000-000000000003" }),
    );

    expect(created.outcome).toBe("created");
    expect(replayed.outcome).toBe("replayed");
    expect(reopened.outcome).toBe("reopened");
    expect(reopened.resource).toEqual(created.resource);
    expect(tmux.creations).toBe(1);
  });

  it("derives alias-stable identities and separates same-basename roots", async () => {
    const first = deriveWorkspaceOpenIdentity("/one/project");
    const alias = deriveWorkspaceOpenIdentity("/one/project");
    const collision = deriveWorkspaceOpenIdentity("/two/project");
    expect(first).toEqual({
      workspaceName: "project-2eb2e31cb1b3c4a359f73f4ebe8b94de",
      sessionName: "project-2eb2e31cb1b3c4a359f73f4ebe8b94de",
      projectKey: "2eb2e31cb1b3c4a359f73f4ebe8b94de",
      initialPaneId: "pane.workspace.2eb2e31cb1b3c4a359f73f4ebe8b94de",
      initialWindowId: "window.workspace.2eb2e31cb1b3c4a359f73f4ebe8b94de",
    });
    expect(alias).toEqual(first);
    expect(collision.workspaceName).not.toBe(first.workspaceName);
    expect(collision.initialPaneId).not.toBe(first.initialPaneId);
    expect(first.workspaceName.endsWith(first.projectKey)).toBe(true);
    expect(first.workspaceName.length).toBeLessThanOrEqual(97);
  });

  it("rejects a configured project instead of silently treating it as config-free", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-open-configured-"));
    const tmux = new FakeTmux();
    try {
      writeFileSync(
        join(root, "ide.yml"),
        "name: configured\nrows:\n  - panes:\n      - title: Shell\n",
      );
      const authority = new WorkspaceOpenAuthority({
        daemonInstanceId: DAEMON,
        registry: new MemoryRegistry(),
        io: {
          runTmux: tmux.run,
          isMissingTmuxTarget: () => false,
          isTmuxUnavailable: () => false,
        },
      });

      await expect(authority.open(request({ intent: { projectDir: root } }))).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "workspace_unavailable",
      );
      expect(tmux.creations).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an unrelated tmux session at the derived name without killing it", async () => {
    const tmux = new FakeTmux();
    const { authority, identity } = rig({ tmux });
    tmux.install(identity);
    tmux.session!.options.set("@tmux_ide_workspace_open_v1", "another-project");

    await expect(authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "session_conflict",
    );
    expect(tmux.session).not.toBeNull();
    expect(tmux.calls.some((call) => call[0] === "kill-session")).toBe(false);
  });

  it("adopts a fully stamped compatible winner after a create race", async () => {
    const tmux = new FakeTmux();
    const { authority, identity, registry } = rig({ tmux });
    tmux.racedIdentity = identity;

    const result = await authority.open(request());
    expect(result.outcome).toBe("reopened");
    expect(result.resource.workspaceName).toBe(identity.workspaceName);
    expect(registry.workspaces).toHaveLength(1);
    expect(tmux.session?.id).toBe("$9");
    expect(tmux.calls.some((call) => call[0] === "kill-session")).toBe(false);
  });

  it("re-proves exact registry membership and mapping before replay", async () => {
    const deleted = rig();
    await deleted.authority.open(request());
    deleted.registry.workspaces.splice(0);
    await expect(deleted.authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );

    const altered = rig();
    await altered.authority.open(request());
    altered.registry.workspaces[0]!.sessionName = "another-session";
    await expect(altered.authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );
  });

  it("rejects replay when a later registry alias duplicates the canonical membership", async () => {
    const { authority, identity, registry } = rig();
    await authority.open(request());
    registry.workspaces.push({
      name: "later-alias",
      sessionName: identity.sessionName,
      projectDir: CANONICAL_ROOT,
      ideConfigPath: null,
      configKind: "none",
      configPath: null,
      hasWorkspaceConfig: false,
      addedAt: "2026-07-22T00:00:01.000Z",
    });

    await expect(authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );
  });

  it("rejects replay after the exact tmux session has been renamed", async () => {
    const { authority, tmux } = rig();
    await authority.open(request());
    tmux.session!.name = "renamed-outside-tmux-ide";

    await expect(authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );
  });

  it("rejects a moved initial pane or a split initial window", async () => {
    const moved = rig();
    await moved.authority.open(request());
    moved.tmux.session!.windowId = "@77";
    moved.tmux.session!.windowOptions.clear();
    await expect(moved.authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );

    const split = rig();
    await split.authority.open(request());
    split.tmux.session!.paneCount = 2;
    await expect(split.authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );
  });

  it("rejects duplicate semantic stamps and altered initial-pane metadata", async () => {
    const duplicate = rig();
    await duplicate.authority.open(request());
    duplicate.tmux.session!.extraPanes.push({
      paneId: "%88",
      windowId: "@88",
      title: "Other",
      paneOptions: new Map([
        ["@tmux_ide_pane_id", duplicate.identity.initialPaneId],
        ["@ide_type", "agent"],
        ["@ide_role", "implementer"],
        ["@ide_name", "Duplicate"],
      ]),
      windowOptions: new Map(),
    });
    await expect(duplicate.authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );

    const duplicateWindow = rig();
    await duplicateWindow.authority.open(request());
    duplicateWindow.tmux.session!.extraPanes.push({
      paneId: "%89",
      windowId: "@89",
      title: "Terminal",
      paneOptions: new Map([
        ["@tmux_ide_pane_id", "pane.50000000000040008000000000000005"],
        ["@ide_type", "shell"],
        ["@ide_role", "shell"],
        ["@ide_name", "Terminal"],
      ]),
      windowOptions: new Map([["@tmux_ide_window_id", duplicateWindow.identity.initialWindowId]]),
    });
    await expect(duplicateWindow.authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );

    const altered = rig();
    await altered.authority.open(request());
    altered.tmux.session!.paneOptions.set("@ide_role", "implementer");
    await expect(altered.authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_resource_changed",
    );
  });

  it("reopens after later application windows when every pane remains uniquely semantic", async () => {
    const { authority, tmux } = rig();
    await authority.open(request());
    tmux.session!.extraPanes.push({
      paneId: "%88",
      windowId: "@88",
      title: "Implementer",
      paneOptions: new Map([
        ["@tmux_ide_pane_id", "pane.30000000000040008000000000000003"],
        ["@ide_type", "agent"],
        ["@ide_role", "implementer"],
        ["@ide_name", "Implementer"],
      ]),
      windowOptions: new Map(),
    });

    await expect(
      authority.open(request({ operationId: "30000000-0000-4000-8000-000000000003" })),
    ).resolves.toMatchObject({ outcome: "reopened" });
  });

  it("refuses a canonical project already registered under another identity", async () => {
    const registry = new MemoryRegistry([
      {
        name: "legacy-name",
        sessionName: "legacy-session",
        projectDir: CANONICAL_ROOT,
        ideConfigPath: null,
        configKind: "none",
        configPath: null,
        hasWorkspaceConfig: false,
        addedAt: "2026-07-22T00:00:00.000Z",
      },
    ]);
    const { authority, tmux } = rig({ registry });

    await expect(authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_conflict",
    );
    expect(tmux.creations).toBe(0);
  });

  it("rolls back only the exact operation-owned session after partial setup failure", async () => {
    const tmux = new FakeTmux();
    tmux.failOption = "@tmux_ide_workspace_name";
    const { authority } = rig({ tmux });

    await expect(authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_creation_failed",
    );
    expect(tmux.session).toBeNull();
    expect(tmux.calls.find((call) => call[0] === "kill-session")).toEqual([
      "kill-session",
      "-t",
      "$1",
    ]);
  });

  it("preserves a session when operation ownership cannot be proven during rollback", async () => {
    const tmux = new FakeTmux();
    tmux.failOption = "@tmux_ide_workspace_open_operation";
    const { authority } = rig({ tmux });

    await expect(authority.open(request())).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "workspace_cleanup_unproven",
    );
    expect(tmux.session).not.toBeNull();
    expect(tmux.calls.some((call) => call[0] === "kill-session")).toBe(false);
  });

  it("preserves daemon generation and operation correlation semantics", async () => {
    const { authority } = rig();
    await expect(
      authority.open(request({ expectedDaemonInstanceId: "40000000-0000-4000-8000-000000000004" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "daemon_instance_mismatch");

    await authority.open(request());
    await expect(
      authority.open(request({ intent: { projectDir: "/different/intent" } })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "operation_conflict");
  });
});
