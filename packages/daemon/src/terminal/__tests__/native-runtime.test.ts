import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalAttachRequest } from "@tmux-ide/contracts";
import { TmuxError } from "@tmux-ide/tmux-bridge";

import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import type { DirectTerminalSocket } from "../attachments/direct-websocket.ts";
import {
  TERMINAL_ATTACHMENT_REDEEM_PATH,
  TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL,
} from "../attachments/direct-websocket.ts";
import { groupedTmuxViewSessionName, type TmuxArgvPlan } from "../attachments/grouped-tmux.ts";
import type { AttachmentLeaseDescriptor } from "../attachments/lease-manager.ts";
import {
  NativeTerminalAttachmentGeometryResolver,
  NativeTerminalAttachmentRuntimeError,
  WorkspaceTerminalInventoryRuntime,
  createNativeTerminalAttachmentRuntime,
  discoverWorkspaceRegistryTerminalInventory,
  discoverWorkspaceRegistrySemanticPanes,
  type NativeTerminalAttachmentCommandExecutor,
  type NativeTerminalInventorySnapshot,
} from "../attachments/native-runtime.ts";
import {
  SemanticPaneCatalog,
  type TrustedSemanticPaneSnapshot,
} from "../attachments/semantic-pane-catalog.ts";
import {
  TmuxAttachmentOperationSerializer,
  type TmuxAttachmentCommandRunner,
} from "../attachments/tmux-view-executor.ts";
import type { SessionRuntimeRegistry } from "../session-runtime/registry.ts";
import type { TrustedMirrorSessionInventory } from "../mirror/trusted-inventory.ts";
import {
  DISABLED_SESSION_RUNTIME_OBSERVABILITY,
  createSessionRuntimeObservability,
} from "../session-runtime/runtime-observability.ts";
import { MockPtyAdapter } from "./MockPtyAdapter.ts";

const INSTANCE_ID = "daemon-instance-a1";
const REQUEST_ID = "25f3e0c9-00eb-434a-9c90-d59f6f62facf";
const LEASE_ID = "f3d8bc0b-460c-458c-b9c0-dbc2536d1486";
const ATTEMPT_ID = "a45072f8-5a82-4930-8bed-0959c617e60b";

function asyncRead(execute: NativeTerminalAttachmentCommandExecutor) {
  return async (
    executable: string,
    argv: readonly string[],
    options: Parameters<NativeTerminalAttachmentCommandExecutor>[2],
  ) => execute(executable, argv, options);
}
const ORIGIN = "tmux-ide://app";
const WS_URL = "ws://127.0.0.1:6070/v1/terminal/attachments/redeem";
const INVENTORY_SEPARATOR = "|tmux-ide-field-v2|";
const VIEW_SEPARATOR = "|tmux-ide-view-field-v1|";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRegistry(workspaceName = "workspace.alpha", sessionName = "runtime-session") {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-native-runtime-"));
  roots.push(root);
  const result = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
  result.add({ name: workspaceName, sessionName, projectDir: root });
  return { registry: result, root };
}

function createEmptyRegistry() {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-native-runtime-empty-"));
  roots.push(root);
  return {
    registry: new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] }),
    root,
  };
}

function authority(root: string) {
  const executablePath = join(root, "trusted-tmux");
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  chmodSync(executablePath, 0o755);
  return {
    executablePath,
    socketSelector: { kind: "name" as const, name: "native-runtime-test" },
    trustedCwd: root,
    environment: {
      TERM: "screen-256color",
      LANG: "C",
      PATH: `${root}:/hostile`,
      TMUX: "/tmp/hostile,1,2",
      BASH_ENV: "/tmp/hostile-hook",
      SECRET_TOKEN: "must-not-cross",
    },
  };
}

function row(overrides: Partial<TrustedSemanticPaneSnapshot> = {}): TrustedSemanticPaneSnapshot {
  return {
    workspaceName: "workspace.alpha",
    semanticPaneId: "pane.agent",
    sessionId: "$1",
    windowId: "@2",
    runtimePaneId: "%3",
    windowPaneCount: 1,
    sessionWindowCount: 2,
    ...overrides,
  };
}

function trustedInventory(
  panes: ReadonlyArray<{
    readonly paneId: string;
    readonly windowId: string;
    readonly semanticPaneId: string;
    readonly semanticWindowId: string;
    readonly active: boolean;
  }> = [
    {
      paneId: "%3",
      windowId: "@2",
      semanticPaneId: "pane.agent",
      semanticWindowId: "window.promoted.abc123",
      active: true,
    },
  ],
): TrustedMirrorSessionInventory {
  return {
    sessionName: "runtime:session",
    runtimeSessionId: "$7",
    panes: panes.map((pane, index) => ({
      runtimeSessionId: "$7",
      runtimeWindowId: pane.windowId,
      runtimePaneId: pane.paneId,
      semanticWindowId: pane.semanticWindowId,
      semanticPaneId: pane.semanticPaneId,
      windowPaneCount: 1,
      sessionWindowCount: panes.length,
      paneIndex: 0,
      title: `Pane ${index + 1}`,
      currentCommand: "zsh",
      active: pane.active,
      role: null,
      name: null,
      type: null,
      missionStamp: null,
      dir: "/repo",
    })),
  };
}

function applicationShellPaneWire(
  sessionName: string,
  options: {
    stamp?: string;
    windowStamp?: string;
    paneId?: string;
    role?: string;
    mission?: string;
    cwd?: string;
  } = {},
): string {
  return [
    sessionName,
    "$7",
    "@2",
    options.paneId ?? "%3",
    "1",
    "1",
    options.stamp ?? "pane.agent",
    "0",
    "Agent",
    "codex",
    "1",
    "1",
    options.role ?? "teammate",
    "Codex",
    "agent",
    options.mission ?? "",
    options.cwd ?? "/repo",
    options.windowStamp ?? "",
    "tmux-ide-pane-v2",
  ].join(INVENTORY_SEPARATOR);
}

function request(): TerminalAttachRequest {
  return {
    protocolVersion: 1,
    target: { workspaceName: "workspace.alpha", semanticPaneId: "pane.agent" },
    viewerMode: "interactive",
    geometryOwnership: "passive",
    viewport: { cols: 120, rows: 40 },
  };
}

function descriptor(overrides: Partial<AttachmentLeaseDescriptor> = {}): AttachmentLeaseDescriptor {
  return {
    leaseId: LEASE_ID,
    requestId: REQUEST_ID,
    target: request().target,
    viewerMode: "interactive",
    status: "active",
    issuedAt: 1_000,
    expiresAt: 61_000,
    graceExpiresAt: null,
    bindingGeneration: 0,
    viewGeneration: 0,
    ...overrides,
  };
}

describe("workspace-registry semantic pane discovery", () => {
  function inventoryRunner(
    sessionName: string,
    paneRows: string,
  ): {
    readonly runner: TmuxAttachmentCommandRunner;
    readonly calls: string[][];
  } {
    const calls: string[][] = [];
    const runner: TmuxAttachmentCommandRunner = {
      run(command) {
        calls.push([...command.argv]);
        if (command.argv[0] === "list-sessions") {
          return {
            status: "ok",
            stdout: [sessionName, "$1", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n",
          };
        }
        if (command.argv[0] === "list-panes") return { status: "ok", stdout: paneRows };
        return { status: "failed" };
      },
    };
    return { runner, calls };
  }

  function paneWire(
    sessionName: string,
    options: {
      stamp?: string;
      windowId?: string;
      paneId?: string;
      windows?: number;
      panes?: number;
      windowStamp?: string;
      active?: boolean;
    } = {},
  ): string {
    return [
      sessionName,
      "$1",
      options.windowId ?? "@2",
      options.paneId ?? "%3",
      String(options.panes ?? 1),
      String(options.windows ?? 1),
      options.stamp ?? "pane.agent",
      "0",
      "Agent",
      "codex",
      options.active === false ? "0" : "1",
      options.active === false ? "0" : "1",
      "teammate",
      "Codex",
      "agent",
      "",
      "/repo",
      options.windowStamp ?? "",
      "tmux-ide-pane-v2",
    ].join(INVENTORY_SEPARATOR);
  }

  it.each(["runtime-session-different", "runtime:session"])(
    "maps semantic workspace name to exact session %s, then targets only its runtime id",
    async (sessionName) => {
      const { registry } = createRegistry("workspace.alpha", sessionName);
      const { runner, calls } = inventoryRunner(sessionName, `${paneWire(sessionName)}\n`);
      const catalog = new SemanticPaneCatalog({
        discover: () => discoverWorkspaceRegistrySemanticPanes(registry, runner),
      });

      await expect(catalog.resolve(request().target)).resolves.toMatchObject({
        target: request().target,
        source: { sessionId: "$1", windowId: "@2", runtimePaneId: "%3" },
      });
      expect(calls).toHaveLength(3);
      expect(calls.slice(1).every((call) => call.includes("$1"))).toBe(true);
      expect(calls.flat()).not.toContain(`=${sessionName}`);
      expect(calls.flat()).not.toContain("=workspace.alpha");
      expect(calls.flat().join("\n")).not.toContain("#{qa:");
    },
  );

  it.each([
    ["missing stamp", `${paneWire("runtime-session", { stamp: "" })}\n`, "missing-semantic-stamp"],
    [
      "duplicate stamp",
      `${paneWire("runtime-session", { windows: 2 })}\n${paneWire("runtime-session", { windowId: "@4", paneId: "%5", windows: 2, active: false })}\n`,
      "duplicate-semantic-stamp",
    ],
  ])("rejects %s from exact registry-backed discovery", async (_label, stdout, code) => {
    const { registry } = createRegistry();
    const { runner } = inventoryRunner("runtime-session", stdout);
    const catalog = new SemanticPaneCatalog({
      discover: () => discoverWorkspaceRegistrySemanticPanes(registry, runner),
    });
    await expect(catalog.resolve(request().target)).rejects.toMatchObject({ code });
  });

  it("resolves a stamped multi-pane window through real discovery (m41 attach-2)", async () => {
    const sessionName = "multi-session";
    const { registry } = createRegistry("workspace.alpha", sessionName);
    const rows = [
      paneWire(sessionName, {
        panes: 2,
        paneId: "%3",
        stamp: "pane.agent",
        windowStamp: "window.workspace.alpha",
      }),
      paneWire(sessionName, {
        panes: 2,
        paneId: "%4",
        stamp: "pane.worker",
        windowStamp: "window.workspace.alpha",
        active: false,
      }),
    ].join("\n");
    const { runner } = inventoryRunner(sessionName, `${rows}\n`);
    const catalog = new SemanticPaneCatalog({
      discover: () => discoverWorkspaceRegistrySemanticPanes(registry, runner),
    });
    await expect(catalog.resolve(request().target)).resolves.toMatchObject({
      source: {
        sessionId: "$1",
        windowId: "@2",
        runtimePaneId: "%3",
        windowPaneCount: 2,
        windowStamp: "window.workspace.alpha",
      },
    });
  });

  it("refuses an unstamped multi-pane window and fails closed", async () => {
    const sessionName = "multi-unstamped";
    const { registry } = createRegistry("workspace.alpha", sessionName);
    const rows = [
      paneWire(sessionName, { panes: 2, paneId: "%3", stamp: "pane.agent" }),
      paneWire(sessionName, { panes: 2, paneId: "%4", stamp: "pane.worker", active: false }),
    ].join("\n");
    const { runner } = inventoryRunner(sessionName, `${rows}\n`);
    const catalog = new SemanticPaneCatalog({
      discover: () => discoverWorkspaceRegistrySemanticPanes(registry, runner),
    });
    await expect(catalog.resolve(request().target)).rejects.toMatchObject({
      code: "missing-window-stamp",
    });
  });

  it("rejects a pane topology race between exact before/after snapshots", async () => {
    const { registry } = createRegistry();
    let paneReads = 0;
    const base = inventoryRunner("runtime-session", "");
    const runner: TmuxAttachmentCommandRunner = {
      run(command) {
        if (command.argv[0] === "list-sessions") return base.runner.run(command);
        paneReads += 1;
        return {
          status: "ok",
          stdout: `${paneWire("runtime-session", { paneId: paneReads === 1 ? "%3" : "%4" })}\n`,
        };
      },
    };
    await expect(discoverWorkspaceRegistrySemanticPanes(registry, runner)).rejects.toMatchObject({
      code: "discovery-failed",
    });
  });

  it("applies unstamped and duplicate faults globally to the inventory analyzer", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "session-a");
    registry.add({ name: "workspace.beta", sessionName: "session-b", projectDir: root });
    const snapshots = new Map([
      ["$1", `${paneWire("session-a")}\n`],
      [
        "$2",
        `${paneWire("session-b", { stamp: "" }).replace(`session-b${INVENTORY_SEPARATOR}$1`, `session-b${INVENTORY_SEPARATOR}$2`)}\n`,
      ],
    ]);
    const runner: TmuxAttachmentCommandRunner = {
      run(command) {
        if (command.argv[0] === "list-sessions") {
          return {
            status: "ok",
            stdout:
              [
                ["session-a", "$1", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR),
                ["session-b", "$2", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR),
              ].join("\n") + "\n",
          };
        }
        const target = command.argv[command.argv.indexOf("-t") + 1]!;
        return { status: "ok", stdout: snapshots.get(target) ?? "" };
      },
    };
    const inventory = await discoverWorkspaceRegistryTerminalInventory(registry, runner);
    expect(inventory.catalog.missingSemanticStamp).toBe(true);
    expect(inventory.catalog.invalidRuntimeProof).toBe(false);

    registry.add({ name: "workspace.alias", sessionName: "session-a", projectDir: root });
    const aliased = await discoverWorkspaceRegistryTerminalInventory(registry, runner);
    expect(aliased.catalog.duplicateRuntimePaneBinding).toBe(true);
  });
});

describe("native terminal attachment geometry", () => {
  function geometryRig(output: (viewName: string) => string) {
    let discovered = row();
    const catalog = new SemanticPaneCatalog({ discover: () => [discovered] });
    const calls: TmuxArgvPlan[] = [];
    const runner: TmuxAttachmentCommandRunner = {
      run(command) {
        calls.push({ executable: "tmux", argv: [...command.argv] });
        return { status: "ok", stdout: output(groupedTmuxViewSessionName(LEASE_ID, 0)) };
      },
    };
    const resolver = new NativeTerminalAttachmentGeometryResolver({
      catalog,
      runner,
      operationSerializer: new TmuxAttachmentOperationSerializer(),
    });
    return {
      catalog,
      resolver,
      calls,
      mutate(next: TrustedSemanticPaneSnapshot) {
        discovered = next;
      },
    };
  }

  const claim = { attemptId: ATTEMPT_ID, attachmentId: LEASE_ID, generation: 0, pid: 4321 };

  it("returns geometry only after one exact view client matches the claimed PTY pid", async () => {
    const rig = geometryRig(
      (viewName) => `source\t$1\t@2\t%3\t1\t120\t40\nclient\t4321\t${viewName}\t118\t38\n`,
    );
    await expect(rig.resolver.resolve(descriptor(), claim)).resolves.toEqual({
      sourceGrid: { cols: 120, rows: 40 },
      clientViewport: { cols: 118, rows: 38 },
    });
    const serialized = rig.calls[0]!.argv.join(" ");
    expect(serialized).toContain("$1:@2.%3");
    expect(serialized).toContain(groupedTmuxViewSessionName(LEASE_ID, 0));
    expect(serialized).toContain(`v1:${LEASE_ID}:0`);
    // The render grid is the WHOLE window and the guard no longer gates panes.
    expect(serialized).toContain("#{window_width}");
    expect(serialized).toContain("#{window_height}");
    expect(serialized).not.toContain("#{==:#{window_panes},1}");
  });

  it("resolves a multi-pane window with the window as the render grid (m41 attach-2)", async () => {
    const rig = geometryRig(
      (viewName) => `source\t$1\t@2\t%3\t9\t200\t50\nclient\t4321\t${viewName}\t200\t50\n`,
    );
    rig.mutate(row({ windowPaneCount: 9, windowStamp: "window.workspace.alpha" }));
    await expect(rig.resolver.resolve(descriptor(), claim)).resolves.toEqual({
      sourceGrid: { cols: 200, rows: 50 },
      clientViewport: { cols: 200, rows: 50 },
    });
  });

  it("fails closed when live window_panes disagrees with the resolved windowPaneCount", async () => {
    const rig = geometryRig(
      (viewName) => `source\t$1\t@2\t%3\t8\t200\t50\nclient\t4321\t${viewName}\t200\t50\n`,
    );
    rig.mutate(row({ windowPaneCount: 9, windowStamp: "window.workspace.alpha" }));
    await expect(rig.resolver.resolve(descriptor(), claim)).rejects.toBeInstanceOf(
      NativeTerminalAttachmentRuntimeError,
    );
  });

  it.each([
    [
      "wrong pid",
      (view: string) => `source\t$1\t@2\t%3\t1\t120\t40\nclient\t9999\t${view}\t118\t38\n`,
    ],
    ["wrong view", () => "source\t$1\t@2\t%3\t1\t120\t40\nclient\t4321\tforeign-view\t118\t38\n"],
    [
      "multiple clients",
      (view: string) =>
        `source\t$1\t@2\t%3\t1\t120\t40\nclient\t4321\t${view}\t118\t38\nclient\t5555\t${view}\t80\t24\n`,
    ],
    [
      "source guard mismatch",
      (view: string) => `source\t$8\t@2\t%3\t1\t120\t40\nclient\t4321\t${view}\t118\t38\n`,
    ],
    ["view guard mismatch", () => "__tmux_ide_geometry_view_mismatch_v1__\n"],
  ])("fails closed for %s", async (_label, output) => {
    const rig = geometryRig(output);
    await expect(rig.resolver.resolve(descriptor(), claim)).rejects.toBeInstanceOf(
      NativeTerminalAttachmentRuntimeError,
    );
  });

  it("rejects external source rebinding after the descriptor generation was issued", async () => {
    const rig = geometryRig(
      (viewName) => `source\t$1\t@2\t%3\t1\t120\t40\nclient\t4321\t${viewName}\t118\t38\n`,
    );
    await rig.catalog.resolve(request().target);
    rig.mutate(row({ sessionId: "$8", windowId: "@9", runtimePaneId: "%10" }));
    await expect(rig.resolver.resolve(descriptor(), claim)).rejects.toMatchObject({
      code: "geometry-mismatch",
    });
    expect(rig.calls).toHaveLength(0);
  });
});

class FakeSocket extends EventEmitter implements DirectTerminalSocket {
  readyState = 1;
  bufferedAmount = 0;

  send(): void {}

  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }

  frame(data: string): void {
    this.emit("message", data, false);
  }
}

class RuntimeTmuxModel {
  viewName = "";
  marker = "";
  viewExists = false;
  proofReady = false;
  readonly environments: NodeJS.ProcessEnv[] = [];

  constructor(readonly adapter: MockPtyAdapter) {}

  execute: NativeTerminalAttachmentCommandExecutor = (_executable, rawArgv, options) => {
    this.environments.push({ ...options.env });
    const argv = rawArgv.slice(2);
    const serialized = argv.join(" ");
    if (argv[0] === "has-session") {
      if (!this.viewExists) throw new TmuxError("missing", "SESSION_NOT_FOUND");
      return "";
    }
    if (argv[0] === "show-environment") {
      if (!this.viewExists) throw new TmuxError("missing", "SESSION_NOT_FOUND");
      return `TMUX_IDE_ATTACHMENT_VIEW=${this.marker}\n`;
    }
    if (argv[0] === "list-windows") return this.viewExists ? "@2\n" : "";
    if (argv[0] === "list-sessions") return "";
    if (argv[0] === "list-panes") {
      const target = argv[argv.indexOf("-t") + 1] ?? "";
      if (target.startsWith("=")) {
        if (argv.at(-1) === "#{session_id}") return "$9\n";
        return "$9\t@2\t%3\t1\t1\n";
      }
      return "$1\t@2\t%3\t1\n";
    }
    if (argv[0] === "if-shell" && serialized.includes("new-session")) {
      const match = /_tmux-ide-view-v1-[0-9a-f]{32}-[0-9a-z]+/u.exec(serialized);
      if (!match) throw new Error("missing view name");
      this.viewName = match[0];
      this.marker = `v1:${LEASE_ID}:0`;
      this.viewExists = true;
      return "";
    }
    if (argv[0] === "if-shell" && serialized.includes("kill-session")) {
      this.viewExists = false;
      return "";
    }
    if (argv[0] === "if-shell" && serialized.includes("client\\t#{client_pid}")) {
      return `source\t$1\t@2\t%3\t1\t120\t40\nclient\t${this.adapter.lastSpawned()!.pid}\t${this.viewName}\t118\t38\n`;
    }
    if (argv[0] === "if-shell" && serialized.includes("list-clients")) {
      if (!this.proofReady) return "";
      return `${this.adapter.lastSpawned()!.pid}\t${this.viewName}\n`;
    }
    return "";
  };
}

class StartupReconciliationTmuxModel {
  readonly viewName = groupedTmuxViewSessionName(LEASE_ID, 0);
  readonly marker = `v1:${LEASE_ID}:0`;
  readonly events: string[];
  viewExists = true;
  cleanupFailure = false;

  constructor(events: string[] = []) {
    this.events = events;
  }

  execute: NativeTerminalAttachmentCommandExecutor = (_executable, rawArgv) => {
    const argv = rawArgv.slice(2);
    const targetIndex = argv.indexOf("-t");
    const target = targetIndex < 0 ? "" : (argv[targetIndex + 1] ?? "");
    if (argv[0] === "list-sessions") {
      this.events.push("enumerate-orphans");
      return this.viewExists ? `${this.viewName}${VIEW_SEPARATOR}$9\n` : "";
    }
    if (argv[0] === "show-environment") {
      if (!this.viewExists) throw new TmuxError("missing", "SESSION_NOT_FOUND");
      return `TMUX_IDE_ATTACHMENT_VIEW=${this.marker}\n`;
    }
    if (argv[0] === "has-session") {
      if (!this.viewExists) throw new TmuxError("missing", "SESSION_NOT_FOUND");
      return "";
    }
    if (argv[0] === "list-windows" && target === `=${this.viewName}`) {
      if (!this.viewExists) throw new TmuxError("missing", "SESSION_NOT_FOUND");
      return "@2\n";
    }
    if (argv[0] === "list-panes" && target === `=${this.viewName}`) {
      if (!this.viewExists) throw new TmuxError("missing", "SESSION_NOT_FOUND");
      if (argv.at(-1) === "#{session_id}") return "$9\n";
      return "$9\t@2\t%3\t1\t1\n";
    }
    if (argv[0] === "if-shell" && argv.join(" ").includes("kill-session")) {
      this.events.push("cleanup-orphan");
      if (this.cleanupFailure) throw new Error("raw cleanup failure must not escape");
      this.viewExists = false;
      return "";
    }
    return "";
  };
}

describe("async terminal inventory reads", () => {
  const syncStartup = (_executable: string, rawArgv: readonly string[]) => {
    const argv = rawArgv.slice(2);
    return argv[0] === "list-sessions" ? "" : "";
  };

  it("retries one transient pre-publication orphan enumeration and remains fail closed", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let enumerations = 0;
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: (_executable, rawArgv) => {
        const argv = rawArgv.slice(2);
        if (argv[0] !== "list-sessions") return "";
        enumerations += 1;
        if (enumerations === 1) throw new Error("transient cold contender timeout");
        return "";
      },
    });

    await expect(runtime.whenReady()).resolves.toBeUndefined();
    expect(enumerations).toBe(2);
    runtime.dispose();

    let persistentEnumerations = 0;
    const failed = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: () => {
        persistentEnumerations += 1;
        throw new Error("persistent enumeration failure");
      },
    });
    await expect(failed.whenReady()).rejects.toMatchObject({
      code: "orphan-reconciliation-failed",
    });
    expect(persistentEnumerations).toBe(2);
    failed.dispose();
  });

  it("records resource boundary instants only when daemon diagnostics are enabled", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const operations: string[] = [];
    const enabled = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      observability: createSessionRuntimeObservability({
        nowMicros: (() => {
          let now = 0;
          return () => (now += 10);
        })(),
        onSpan: (span) => {
          operations.push(span.operation);
          throw new Error("diagnostic sink failed");
        },
      }),
    });
    enabled.recordTerminalRuntimeResourceMark("terminal-resource-handler-admitted");
    enabled.recordTerminalRuntimeResourceMark("terminal-resource-response-projection");
    expect(operations).toEqual([
      "terminal-resource-handler-admitted",
      "terminal-resource-response-projection",
    ]);
    enabled.dispose();

    const nowMicros = vi.fn(() => 1);
    const disabled = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      observability: { ...DISABLED_SESSION_RUNTIME_OBSERVABILITY, nowMicros },
    });
    disabled.recordTerminalRuntimeResourceMark("terminal-resource-handler-admitted");
    disabled.recordTerminalRuntimeResourceMark("terminal-resource-response-projection");
    expect(nowMicros).not.toHaveBeenCalled();
    disabled.dispose();
  });

  function asyncInventory(
    sessionName: string,
    calls: Array<{
      executable: string;
      argv: readonly string[];
      options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal };
    }>,
  ) {
    return async (
      executable: string,
      rawArgv: readonly string[],
      options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
    ) => {
      calls.push({ executable, argv: [...rawArgv], options });
      const argv = rawArgv.slice(2);
      if (argv[0] === "list-sessions")
        return [sessionName, "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n";
      if (argv[0] === "list-panes")
        return `${applicationShellPaneWire(sessionName, { windowStamp: "window.promoted.abc123" })}\n`;
      return "";
    };
  }

  it("pins async reads and single-flights only concurrent callers", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const calls: Array<{
      executable: string;
      argv: readonly string[];
      options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal };
    }> = [];
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", calls),
    });
    await runtime.whenReady();

    const [first, second] = await Promise.all([
      runtime.discoverTerminalInventory(),
      runtime.discoverTerminalInventory(),
    ]);
    expect(first).toEqual(second);
    expect(calls).toHaveLength(3);
    expect(calls.every(({ argv }) => argv[0] === "-L" && argv[1] === "native-runtime-test")).toBe(
      true,
    );
    expect(new Set(calls.map(({ executable }) => executable))).toEqual(
      new Set([realpathSync(authority(root).executablePath)]),
    );
    expect(new Set(calls.map(({ options }) => options.timeoutMs))).toEqual(new Set([5_000]));
    expect(calls[0]!.options.env).toEqual({ TERM: "screen-256color", LANG: "C" });

    await runtime.discoverTerminalInventory();
    expect(calls).toHaveLength(6);
    runtime.dispose();
  });

  it("publishes each authoritative inventory snapshot to the generation-owned cache seam", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const adopted: NativeTerminalInventorySnapshot[] = [];
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", []),
      onInventory: (snapshot) => adopted.push(snapshot),
    });
    await runtime.whenReady();
    const inventory = await runtime.discoverTerminalInventory();
    expect(adopted).toEqual([inventory]);
    expect(adopted[0]!.panes[0]).toMatchObject({
      sessionName: "runtime:session",
      runtimePaneId: "%3",
      windowId: "@2",
      semanticPaneId: "pane.agent",
    });
    runtime.dispose();
  });

  it("never publishes an external-signal inventory read that crossed invalidation", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const adopted: NativeTerminalInventorySnapshot[] = [];
    let paneReads = 0;
    let resolveOld!: (value: string) => void;
    const oldPaneRead = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: async (_executable, rawArgv) => {
        const argv = rawArgv.slice(2);
        if (argv[0] === "list-sessions")
          return ["runtime:session", "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n";
        if (argv[0] === "list-panes") {
          paneReads += 1;
          if (paneReads === 1) return oldPaneRead;
          return `${applicationShellPaneWire("runtime:session", { stamp: "pane.new" })}\n`;
        }
        return "";
      },
      onInventory: (snapshot) => adopted.push(snapshot),
    });
    await runtime.whenReady();
    const first = runtime.discoverTerminalInventory(new AbortController().signal);
    await vi.waitFor(() => expect(paneReads).toBe(1));
    runtime.invalidate();
    const second = runtime.discoverTerminalInventory(new AbortController().signal);
    await expect(second).resolves.toMatchObject({
      panes: [{ semanticPaneId: "pane.new" }],
    });
    resolveOld(`${applicationShellPaneWire("runtime:session", { stamp: "pane.old" })}\n`);
    await expect(first).resolves.toMatchObject({
      panes: [{ semanticPaneId: "pane.new" }],
    });
    expect(adopted).toHaveLength(2);
    expect(adopted.every(({ panes }) => panes[0]?.semanticPaneId === "pane.new")).toBe(true);
    runtime.dispose();
  });

  it("aborts and fences an invalidated flight, then retries at the current epoch", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let calls = 0;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => (releaseFirst = resolve));
    const execute = async (
      _executable: string,
      rawArgv: readonly string[],
      options: { signal?: AbortSignal },
    ): Promise<string> => {
      calls += 1;
      if (calls === 1) {
        releaseFirst();
        await new Promise<void>((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      }
      const argv = rawArgv.slice(2);
      if (argv[0] === "list-sessions")
        return ["runtime:session", "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n";
      return `${applicationShellPaneWire("runtime:session", { windowStamp: "window.promoted.abc123" })}\n`;
    };
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: execute,
    });
    await runtime.whenReady();
    const first = runtime.discoverTerminalInventory();
    const shared = runtime.discoverTerminalInventory();
    await firstStarted;
    runtime.invalidate();
    const [a, b] = await Promise.all([first, shared]);
    expect(a).toEqual(b);
    expect(calls).toBe(4);
    runtime.dispose();
  });

  it("fails closed on async read failure and does not respawn after dispose abort", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let calls = 0;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: async (_executable, _argv, options) => {
        calls += 1;
        started();
        await new Promise<void>((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
        return "";
      },
    });
    await runtime.whenReady();
    const pending = runtime.discoverTerminalInventory();
    await didStart;
    runtime.dispose();
    await expect(pending).rejects.toMatchObject({ code: "runtime-disposed" });
    expect(calls).toBe(1);

    const failed = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: async () => {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      },
    });
    await failed.whenReady();
    await expect(failed.discoverTerminalInventory()).rejects.toMatchObject({
      code: "discovery-failed",
    });
    failed.dispose();
  });

  it("single-flights same-session inventory plus agent enrichment", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const calls: Array<{
      executable: string;
      argv: readonly string[];
      options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal };
    }> = [];
    let probes = 0;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", calls),
      agentStatusProbe: {
        async probe(_input, signal) {
          probes += 1;
          await Promise.race([
            probeGate,
            new Promise<never>((_resolve, reject) =>
              signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              }),
            ),
          ]);
          return new Map();
        },
      },
    });
    await runtime.whenReady();
    const first = runtime.discoverApplicationShellSession("runtime:session");
    const second = runtime.discoverApplicationShellSession("runtime:session");
    await vi.waitFor(() => expect(probes).toBe(1));
    expect(calls).toHaveLength(3);
    releaseProbe();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(probes).toBe(1);
    runtime.dispose();
  });

  it("uses only proof-qualified retained inventory while preserving agent enrichment", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const readCommandExecutor = vi.fn(async () => {
      throw new Error("process inventory must not run");
    });
    const agentFacts = {
      agentStateRaw: "working:1",
      agentStatusTextRaw: "editing",
      agentDisplayNameRaw: "Codex",
      agentScrapeState: null,
    } as const;
    const probe = vi.fn(async () => new Map([["%3", agentFacts]]));
    const describeTrustedSessionInventory = vi.fn(async () => ({
      sessionName: "runtime:session",
      runtimeSessionId: "$7",
      panes: [
        {
          runtimeSessionId: "$7",
          runtimeWindowId: "@2",
          runtimePaneId: "%3",
          semanticWindowId: "window.promoted.abc123",
          semanticPaneId: "pane.agent",
          windowPaneCount: 1,
          sessionWindowCount: 1,
          paneIndex: 0,
          title: "Agent",
          currentCommand: "codex",
          active: true,
          role: "teammate",
          name: "Codex",
          type: "agent",
          missionStamp: null,
          dir: "/repo",
        },
      ],
    }));
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor,
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => true,
        describeTrustedSessionInventory,
        prewarmProofQualifiedSession: vi.fn(async () => undefined),
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      agentStatusProbe: { probe },
    });
    await runtime.whenReady();

    const trustedSession = await runtime.discoverApplicationShellSession("runtime:session");
    expect(trustedSession).toMatchObject({
      name: "runtime:session",
      runtimeSessionId: "$7",
      catalogIssue: null,
      panes: [expect.objectContaining({ semanticPaneId: "pane.agent", ...agentFacts })],
    });
    expect(describeTrustedSessionInventory).toHaveBeenCalledOnce();
    expect(readCommandExecutor).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledOnce();
    const legacy = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", []),
      agentStatusProbe: { probe: async () => new Map([["%3", agentFacts]]) },
    });
    await legacy.whenReady();
    await expect(legacy.discoverApplicationShellSession("runtime:session")).resolves.toEqual(
      trustedSession,
    );
    legacy.dispose();
    runtime.dispose();
  });

  it("publishes a proof-qualified post-create inventory through the session-scoped adoption seam", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const scoped: Array<{ sessionName: string; snapshot: NativeTerminalInventorySnapshot }> = [];
    const global: NativeTerminalInventorySnapshot[] = [];
    const inventory = trustedInventory([
      {
        paneId: "%3",
        windowId: "@2",
        semanticPaneId: "pane.agent",
        semanticWindowId: "window.promoted.abc123",
        active: false,
      },
      {
        paneId: "%4",
        windowId: "@3",
        semanticPaneId: "pane.created",
        semanticWindowId: "window.promoted.def456",
        active: true,
      },
    ]);
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: vi.fn(async () => {
        throw new Error("global inventory must not run");
      }),
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => true,
        describeTrustedSessionInventory: vi.fn(async () => inventory),
        prewarmProofQualifiedSession: vi.fn(async () => undefined),
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      onInventory: (snapshot) => global.push(snapshot),
      onSessionInventory: (sessionName, snapshot) => {
        if (snapshot) scoped.push({ sessionName, snapshot });
      },
    });
    await runtime.whenReady();

    await expect(runtime.discoverTerminalRuntimeSession("runtime:session")).resolves.toMatchObject({
      panes: [
        expect.objectContaining({ semanticPaneId: "pane.agent", active: false }),
        expect.objectContaining({ semanticPaneId: "pane.created", active: true }),
      ],
    });
    expect(global).toEqual([]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({
      sessionName: "runtime:session",
      snapshot: { panes: [expect.any(Object), expect.any(Object)] },
    });
    runtime.dispose();
  });

  it("falls back to native discovery when a trusted provider snapshot is malformed", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const calls: Array<{ argv: readonly string[] }> = [];
    const scoped = vi.fn();
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", calls),
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => true,
        describeTrustedSessionInventory: vi.fn(async () => ({
          sessionName: "wrong-session",
          runtimeSessionId: "$7",
          panes: [
            {
              runtimeSessionId: "$8",
              runtimeWindowId: "@2",
              runtimePaneId: "%3",
              semanticWindowId: "window.promoted.abc123",
              semanticPaneId: "pane.promoted.abc123",
              windowPaneCount: "1",
              sessionWindowCount: 1,
              paneIndex: 0,
              title: 42,
              currentCommand: "zsh",
              active: "true",
              role: null,
              name: null,
              type: null,
              missionStamp: null,
              dir: "/repo",
            },
          ],
        })),
        prewarmProofQualifiedSession: vi.fn(async () => undefined),
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      onSessionInventory: scoped,
    });
    await runtime.whenReady();

    await expect(runtime.discoverApplicationShellSession("runtime:session")).resolves.toMatchObject(
      {
        name: "runtime:session",
      },
    );
    expect(calls).toHaveLength(3);
    expect(scoped).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("never session-adopts a duplicate trusted pane projection", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const scoped = vi.fn();
    const duplicate = trustedInventory([
      {
        paneId: "%3",
        windowId: "@2",
        semanticPaneId: "pane.agent",
        semanticWindowId: "window.promoted.abc123",
        active: true,
      },
      {
        paneId: "%4",
        windowId: "@3",
        semanticPaneId: "pane.agent",
        semanticWindowId: "window.promoted.def456",
        active: false,
      },
    ]);
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", []),
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => true,
        describeTrustedSessionInventory: vi.fn(async () => duplicate),
        prewarmProofQualifiedSession: vi.fn(async () => undefined),
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      onSessionInventory: scoped,
    });
    await runtime.whenReady();

    await expect(runtime.discoverTerminalRuntimeSession("runtime:session")).resolves.not.toBeNull();
    expect(scoped).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("does not adopt a trusted result after its current runtime qualification is replaced", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let ready = true;
    const scoped = vi.fn();
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: vi.fn(async () => ""),
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => ready,
        describeTrustedSessionInventory: vi.fn(async () => {
          ready = false;
          return trustedInventory();
        }),
        prewarmProofQualifiedSession: vi.fn(async () => undefined),
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      onSessionInventory: scoped,
    });
    await runtime.whenReady();

    await expect(runtime.discoverTerminalRuntimeSession("runtime:session")).rejects.toMatchObject({
      code: "discovery-failed",
    });
    expect(scoped).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("retries the exact current runtime when a qualified replacement overtakes prewarm", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const tokenA = Object.freeze({ runtime: "a" });
    const tokenB = Object.freeze({ runtime: "b" });
    let currentToken: object = tokenA;
    let descriptions = 0;
    const inventoryA = trustedInventory();
    const inventoryBSource = trustedInventory([
      {
        paneId: "%4",
        windowId: "@3",
        semanticPaneId: "pane.current",
        semanticWindowId: "window.promoted.def456",
        active: true,
      },
    ]);
    const inventoryB = {
      ...inventoryBSource,
      runtimeSessionId: "$8",
      panes: inventoryBSource.panes.map((pane) => ({ ...pane, runtimeSessionId: "$8" })),
    };
    const prewarm = vi.fn(async (_sessionName: string, runtimeSessionId: string) => {
      if (runtimeSessionId === "$7") currentToken = tokenB;
    });
    const adopted: NativeTerminalInventorySnapshot[] = [];
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: vi.fn(async () => ""),
      sessionRuntimeRegistry: {
        describeTrustedSessionInventoryCandidate: vi.fn(async () => {
          descriptions += 1;
          return descriptions === 1
            ? { inventory: inventoryA, token: tokenA }
            : { inventory: inventoryB, token: tokenB };
        }),
        isTrustedSessionInventoryCandidateCurrent: (_sessionName: string, token: object) =>
          token === currentToken,
        hasProofQualifiedInventory: () => true,
        prewarmProofQualifiedSession: prewarm,
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      onSessionInventory: (_sessionName, snapshot) => {
        if (snapshot) adopted.push(snapshot);
      },
    });
    await runtime.whenReady();

    await expect(runtime.discoverTerminalRuntimeSession("runtime:session")).resolves.toMatchObject({
      runtimeSessionId: "$8",
      panes: [expect.objectContaining({ semanticPaneId: "pane.current" })],
    });
    expect(descriptions).toBe(2);
    expect(prewarm.mock.calls.map((call) => call[1])).toEqual(["$7", "$8"]);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.panes[0]).toMatchObject({
      sessionId: "$8",
      semanticPaneId: "pane.current",
    });
    runtime.dispose();
  });

  it("aborts a pending trusted provider read on disposal and discards its late result", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    let release!: (value: unknown) => void;
    const provider = new Promise<unknown>((resolve) => (release = resolve));
    const readCommandExecutor = vi.fn(async () => "");
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor,
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => true,
        describeTrustedSessionInventory: vi.fn(() => {
          started();
          return provider;
        }),
        prewarmProofQualifiedSession: vi.fn(async () => undefined),
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
    });
    await runtime.whenReady();
    const pending = runtime.discoverApplicationShellSession("runtime:session");
    await didStart;
    runtime.dispose();
    await expect(pending).rejects.toMatchObject({ code: "runtime-disposed" });
    release({ sessionName: "runtime:session", runtimeSessionId: "$7", panes: [] });
    await Promise.resolve();
    expect(readCommandExecutor).not.toHaveBeenCalled();
  });

  it("aborts a pending trusted provider read from the external request signal", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    let release!: (value: unknown) => void;
    const provider = new Promise<unknown>((resolve) => (release = resolve));
    const nativeRead = vi.fn(async () => "");
    const prewarm = vi.fn(async () => undefined);
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: nativeRead,
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => true,
        describeTrustedSessionInventory: vi.fn(() => {
          started();
          return provider;
        }),
        prewarmProofQualifiedSession: prewarm,
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
    });
    await runtime.whenReady();
    const abort = new AbortController();
    const pending = runtime.discoverTerminalRuntimeSession("runtime:session", abort.signal);
    await didStart;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "runtime-disposed" });
    release({ sessionName: "runtime:session", runtimeSessionId: "$7", panes: [] });
    await Promise.resolve();
    expect(nativeRead).not.toHaveBeenCalled();
    expect(prewarm).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("restarts an invalidated trusted provider epoch and ignores the late old snapshot", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let firstStarted!: () => void;
    const didStart = new Promise<void>((resolve) => (firstStarted = resolve));
    let releaseFirst!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const valid = {
      sessionName: "runtime:session",
      runtimeSessionId: "$7",
      panes: [
        {
          runtimeSessionId: "$7",
          runtimeWindowId: "@2",
          runtimePaneId: "%3",
          semanticWindowId: "window.promoted.abc123",
          semanticPaneId: "pane.agent",
          windowPaneCount: 1,
          sessionWindowCount: 1,
          paneIndex: 0,
          title: "Agent",
          currentCommand: "codex",
          active: true,
          role: "teammate",
          name: "Codex",
          type: "agent",
          missionStamp: null,
          dir: "/repo",
        },
      ],
    };
    const adopted: NativeTerminalInventorySnapshot[] = [];
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: vi.fn(async () => ""),
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => true,
        describeTrustedSessionInventory: vi.fn(() => {
          calls += 1;
          if (calls === 1) {
            firstStarted();
            return first;
          }
          return Promise.resolve(valid);
        }),
        prewarmProofQualifiedSession: vi.fn(async () => undefined),
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      onSessionInventory: (_sessionName, snapshot) => {
        if (snapshot) adopted.push(snapshot);
      },
    });
    await runtime.whenReady();
    const pending = runtime.discoverApplicationShellSession("runtime:session");
    await didStart;
    runtime.invalidate();
    await expect(pending).resolves.toMatchObject({ runtimeSessionId: "$7" });
    releaseFirst({ ...valid, runtimeSessionId: "$9" });
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.panes[0]!.sessionId).toBe("$7");
    runtime.dispose();
  });

  it("fails boundedly when a trusted session inventory crosses two inventory epochs", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const releases: Array<(value: TrustedMirrorSessionInventory) => void> = [];
    const starts: Array<() => void> = [];
    const started = [
      new Promise<void>((resolve) => starts.push(resolve)),
      new Promise<void>((resolve) => starts.push(resolve)),
    ];
    let calls = 0;
    const adopted = vi.fn();
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: vi.fn(async () => ""),
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => true,
        describeTrustedSessionInventory: vi.fn(
          () =>
            new Promise<TrustedMirrorSessionInventory>((resolve) => {
              releases.push(resolve);
              starts[calls]?.();
              calls += 1;
            }),
        ),
        prewarmProofQualifiedSession: vi.fn(async () => undefined),
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      onSessionInventory: adopted,
    });
    await runtime.whenReady();

    const pending = runtime.discoverTerminalRuntimeSession("runtime:session");
    await started[0];
    runtime.invalidate();
    releases[0]!(trustedInventory());
    await started[1];
    runtime.invalidate();
    releases[1]!(trustedInventory());
    await expect(pending).rejects.toMatchObject({ code: "discovery-failed" });
    expect(calls).toBe(2);
    expect(adopted).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("records opt-in application-shell inventory and enrichment spans without tracing ordinary reads", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const operations: string[] = [];
    let now = 10;
    const observability = createSessionRuntimeObservability({
      nowMicros: () => (now += 10),
      onSpan: (span) => operations.push(span.operation),
    });
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", []),
      agentStatusProbe: { probe: async () => new Map() },
      observability,
    });
    await runtime.whenReady();

    await expect(runtime.discoverApplicationShellSession("runtime:session")).resolves.toMatchObject(
      {
        name: "runtime:session",
      },
    );
    expect(operations).toEqual(["terminal-inventory-discovery", "terminal-agent-enrichment"]);
    expect(observability.snapshot().spans).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: "transport", traceId: null })]),
    );
    runtime.dispose();
  });

  it.each(["clock", "sink"] as const)(
    "preserves successful inventory discovery and agent enrichment when the diagnostic %s throws",
    async (failure) => {
      const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
      let now = 0;
      const nowMicros = vi.fn(() => {
        if (failure === "clock") throw new Error("diagnostic clock failed");
        return (now += 10);
      });
      const onSpan = vi.fn(() => {
        if (failure === "sink") throw new Error("diagnostic sink failed");
      });
      const probe = vi.fn(async () => new Map());
      const runtime = new WorkspaceTerminalInventoryRuntime({
        registry,
        tmuxAuthority: authority(root),
        commandExecutor: syncStartup,
        readCommandExecutor: asyncInventory("runtime:session", []),
        agentStatusProbe: { probe },
        observability: createSessionRuntimeObservability({ nowMicros, onSpan }),
      });
      await runtime.whenReady();

      await expect(
        runtime.discoverApplicationShellSession("runtime:session"),
      ).resolves.toMatchObject({
        name: "runtime:session",
        runtimeSessionId: "$7",
      });
      expect(probe).toHaveBeenCalledOnce();
      expect(nowMicros).toHaveBeenCalled();
      if (failure === "sink") expect(onSpan).toHaveBeenCalled();
      runtime.dispose();
    },
  );

  it("projects terminal runtime topology without invoking agent enrichment", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const probe = vi.fn(async () => new Map());
    const operations: string[] = [];
    const observability = createSessionRuntimeObservability({
      nowMicros: (() => {
        let now = 0;
        return () => (now += 10);
      })(),
      onSpan: (span) => operations.push(span.operation),
    });
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", []),
      agentStatusProbe: { probe },
      observability,
    });
    await runtime.whenReady();

    await expect(runtime.discoverTerminalRuntimeSession("runtime:session")).resolves.toMatchObject({
      workspaceName: "workspace.alpha",
      name: "runtime:session",
      runtimeSessionId: "$7",
    });
    expect(probe).not.toHaveBeenCalled();
    expect(operations).toEqual(["terminal-inventory-discovery"]);

    await runtime.discoverApplicationShellSession("runtime:session");
    expect(probe).toHaveBeenCalledOnce();
    expect(operations).toContain("terminal-agent-enrichment");
    runtime.dispose();
  });

  it("aborts an externally cancelled pending native inventory read and discards its late result", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    let release!: (value: string) => void;
    const firstRead = new Promise<string>((resolve) => (release = resolve));
    const prewarm = vi.fn(async () => undefined);
    let reads = 0;
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: async () => {
        reads += 1;
        if (reads === 1) {
          started();
          return firstRead;
        }
        return "";
      },
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => false,
        prewarmProofQualifiedSession: prewarm,
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
    });
    await runtime.whenReady();
    const abort = new AbortController();
    const pending = runtime.discoverTerminalRuntimeSession("runtime:session", abort.signal);
    await didStart;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "runtime-disposed" });
    release("");
    await Promise.resolve();
    await Promise.resolve();
    expect(prewarm).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("aborts a pending runtime prewarm and does not return a late terminal projection", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let prewarmStarted!: () => void;
    const didStartPrewarm = new Promise<void>((resolve) => (prewarmStarted = resolve));
    let releasePrewarm!: () => void;
    const prewarmBarrier = new Promise<void>((resolve) => (releasePrewarm = resolve));
    const prewarm = vi.fn((_sessionName: string, _runtimeSessionId: string) => {
      prewarmStarted();
      return prewarmBarrier;
    });
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", []),
      sessionRuntimeRegistry: {
        hasProofQualifiedInventory: () => false,
        prewarmProofQualifiedSession: prewarm,
        prewarmSession: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
    });
    await runtime.whenReady();
    const abort = new AbortController();
    const pending = runtime.discoverTerminalRuntimeSession("runtime:session", abort.signal);
    await didStartPrewarm;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "runtime-disposed" });
    releasePrewarm();
    await Promise.resolve();
    expect(prewarm).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("records invalidated inventory attempts as two non-overlapping spans", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let calls = 0;
    let firstStarted!: () => void;
    const didStartFirst = new Promise<void>((resolve) => (firstStarted = resolve));
    const points = [10, 20, 30, 40];
    const observability = createSessionRuntimeObservability({
      nowMicros: () => points.shift() ?? 50,
    });
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: async (_executable, rawArgv, options) => {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          await new Promise<never>((_resolve, reject) =>
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          );
        }
        const argv = rawArgv.slice(2);
        if (argv[0] === "list-sessions")
          return ["runtime:session", "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n";
        return `${applicationShellPaneWire("runtime:session", { windowStamp: "window.promoted.abc123" })}\n`;
      },
      observability,
    });
    await runtime.whenReady();

    const pending = runtime.discoverTerminalInventory();
    await didStartFirst;
    runtime.invalidate();
    await expect(pending).resolves.toMatchObject({ panes: expect.any(Array) });
    expect(
      observability
        .snapshot()
        .spans.filter((span) => span.operation === "terminal-inventory-discovery")
        .map(({ startedAtMicros, endedAtMicros }) => [startedAtMicros, endedAtMicros]),
    ).toEqual([
      [10, 20],
      [30, 40],
    ]);
    runtime.dispose();
  });

  it("retries full enrichment on invalidation and rejects dispose during enrichment", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const calls: Array<{
      executable: string;
      argv: readonly string[];
      options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal };
    }> = [];
    let probes = 0;
    let firstProbeStarted!: () => void;
    const didStartFirstProbe = new Promise<void>((resolve) => (firstProbeStarted = resolve));
    const runtime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", calls),
      agentStatusProbe: {
        async probe(_input, signal) {
          probes += 1;
          if (probes === 1) {
            firstProbeStarted();
            await new Promise<never>((_resolve, reject) =>
              signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              }),
            );
          }
          return new Map();
        },
      },
    });
    await runtime.whenReady();
    const pending = runtime.discoverApplicationShellSession("runtime:session");
    await didStartFirstProbe;
    runtime.invalidate();
    await expect(pending).resolves.toMatchObject({ name: "runtime:session" });
    expect(probes).toBe(2);
    expect(calls).toHaveLength(6);

    let disposeProbeStarted!: () => void;
    const didStartDisposeProbe = new Promise<void>((resolve) => (disposeProbeStarted = resolve));
    const disposingRuntime = new WorkspaceTerminalInventoryRuntime({
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: syncStartup,
      readCommandExecutor: asyncInventory("runtime:session", []),
      agentStatusProbe: {
        async probe(_input, signal) {
          disposeProbeStarted();
          return new Promise((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          );
        },
      },
    });
    await disposingRuntime.whenReady();
    const disposedRead = disposingRuntime.discoverApplicationShellSession("runtime:session");
    await didStartDisposeProbe;
    disposingRuntime.dispose();
    await expect(disposedRead).rejects.toMatchObject({ code: "runtime-disposed" });
    await expect(
      disposingRuntime.discoverApplicationShellSession("runtime:session"),
    ).rejects.toMatchObject({ code: "runtime-disposed" });
    runtime.dispose();
  });
});

describe("native terminal attachment runtime lifecycle", () => {
  it("prewarms from authoritative inventory without blocking or failing the shell", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let discoveredSessionName = "runtime:session";
    const prewarmSession = vi.fn(async () => {
      throw new Error("control channel unavailable");
    });
    const retireSession = vi.fn(async () => undefined);
    const execute: NativeTerminalAttachmentCommandExecutor = (_executable, rawArgv) => {
      const argv = rawArgv.slice(2);
      if (argv[0] === "list-sessions" && argv.at(-1)?.includes("tmux-ide-session-v2")) {
        return (
          [discoveredSessionName, "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n"
        );
      }
      if (argv[0] === "list-sessions") return "";
      if (argv[0] === "list-panes") {
        return `${applicationShellPaneWire(discoveredSessionName, { windowStamp: "window.promoted.abc123" })}\n`;
      }
      return "";
    };
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      sessionRuntimeRegistry: {
        prewarmSession,
        retireSession,
      } as unknown as SessionRuntimeRegistry,
      tmuxAuthority: authority(root),
      commandExecutor: execute,
      readCommandExecutor: asyncRead(execute),
    });

    await runtime.whenReady();
    await expect(runtime.discoverApplicationShellSession("runtime:session")).resolves.toMatchObject(
      { name: "runtime:session" },
    );
    expect(prewarmSession).toHaveBeenCalledOnce();
    expect(prewarmSession).toHaveBeenCalledWith("runtime:session");

    registry.renameSession("workspace.alpha", "replacement:session");
    discoveredSessionName = "replacement:session";
    await expect(
      runtime.discoverApplicationShellSession("replacement:session"),
    ).resolves.toMatchObject({ name: "replacement:session" });
    await vi.waitFor(() => expect(retireSession).toHaveBeenCalledWith("runtime:session"));
    expect(prewarmSession).toHaveBeenLastCalledWith("replacement:session");

    registry.remove("workspace.alpha");
    await vi.waitFor(() => expect(retireSession).toHaveBeenCalledWith("replacement:session"));
    await runtime.dispose();
  });

  it("defers prewarm until promotion has authored pane and window identity", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const prewarmSession = vi.fn(async () => undefined);
    let semanticPaneId = "";
    let semanticWindowId = "";
    const execute: NativeTerminalAttachmentCommandExecutor = (_executable, rawArgv) => {
      const argv = rawArgv.slice(2);
      if (argv[0] === "list-sessions" && argv.at(-1)?.includes("tmux-ide-session-v2")) {
        return ["runtime:session", "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n";
      }
      if (argv[0] === "list-sessions") return "";
      if (argv[0] === "list-panes") {
        return `${applicationShellPaneWire("runtime:session", {
          stamp: semanticPaneId,
          windowStamp: semanticWindowId,
        })}\n`;
      }
      return "";
    };
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      sessionRuntimeRegistry: {
        prewarmSession,
        retireSession: vi.fn(async () => undefined),
      } as unknown as SessionRuntimeRegistry,
      tmuxAuthority: authority(root),
      commandExecutor: execute,
      readCommandExecutor: asyncRead(execute),
    });

    await runtime.whenReady();
    await expect(runtime.discoverApplicationShellSession("runtime:session")).resolves.toMatchObject(
      { catalogIssue: "missing-semantic-stamp" },
    );
    expect(prewarmSession).not.toHaveBeenCalled();

    semanticPaneId = "pane.promoted.abc123";
    semanticWindowId = "window.promoted.abc123";
    await expect(runtime.discoverApplicationShellSession("runtime:session")).resolves.toMatchObject(
      { catalogIssue: null },
    );
    expect(prewarmSession).toHaveBeenCalledOnce();
    expect(prewarmSession).toHaveBeenCalledWith("runtime:session");
    await runtime.dispose();
  });

  it("uses the pinned executable and custom socket for exact application-shell inventory", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const calls: Array<{ executable: string; argv: readonly string[]; timeoutMs: number }> = [];
    let paneCwd = "/repo";
    const execute: NativeTerminalAttachmentCommandExecutor = (executable, rawArgv, options) => {
      calls.push({ executable, argv: [...rawArgv], timeoutMs: options.timeoutMs });
      const argv = rawArgv.slice(2);
      if (argv[0] === "list-sessions" && argv.at(-1)?.includes("tmux-ide-session-v2")) {
        return ["runtime:session", "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n";
      }
      if (argv[0] === "list-sessions") return "";
      if (argv[0] === "list-panes") {
        expect(argv[argv.indexOf("-t") + 1]).toBe("$7");
        return `${applicationShellPaneWire("runtime:session", { cwd: paneCwd })}\n`;
      }
      return "";
    };
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: {
        ...authority(root),
        socketSelector: { kind: "name", name: "inventory-socket" },
      },
      commandExecutor: execute,
      readCommandExecutor: asyncRead(execute),
    });

    await runtime.whenReady();
    await expect(runtime.discoverApplicationShellSession("workspace.alpha")).resolves.toBeNull();
    await expect(runtime.discoverApplicationShellSession("runtime:session")).resolves.toMatchObject(
      {
        name: "runtime:session",
        runtimeSessionId: "$7",
        // The inventory fixture reports /repo as the active pane cwd. Durable
        // application state must remain rooted at the registered workspace.
        dir: root,
        catalogIssue: null,
        panes: [expect.objectContaining({ semanticPaneId: "pane.agent", runtimePaneId: "%3" })],
      },
    );
    expect(calls.every(({ argv }) => argv[0] === "-L" && argv[1] === "inventory-socket")).toBe(
      true,
    );
    expect(new Set(calls.map(({ executable }) => executable))).toEqual(
      new Set([realpathSync(authority(root).executablePath)]),
    );
    // Every synchronous tmux command is kill-bounded. A nominal async
    // readiness deadline cannot interrupt execFileSync if tmux itself stalls.
    expect(new Set(calls.map(({ timeoutMs }) => timeoutMs))).toEqual(new Set([5_000]));

    // A long-lived pipeline can outlive its process-group leader, making tmux
    // report an empty pane_current_path even though the pane and registered
    // workspace are healthy. That presentation gap must not take the whole
    // application-shell inventory offline.
    paneCwd = "";
    await expect(runtime.discoverApplicationShellSession("runtime:session")).resolves.toMatchObject(
      {
        dir: root,
        panes: [expect.objectContaining({ runtimePaneId: "%3" })],
      },
    );

    registry.add({ name: "workspace.beta", sessionName: "runtime:session", projectDir: root });
    await expect(runtime.discoverApplicationShellSession("runtime:session")).rejects.toMatchObject({
      code: "discovery-failed",
    });
    await runtime.dispose();
  });

  it("merges injected agent-status probe facts onto discovered panes", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const probed: Array<{ sessionId: string; panes: readonly { runtimePaneId: string }[] }> = [];
    const execute: NativeTerminalAttachmentCommandExecutor = (_executable, rawArgv) => {
      const argv = rawArgv.slice(2);
      if (argv[0] === "list-sessions" && argv.at(-1)?.includes("tmux-ide-session-v2")) {
        return ["runtime:session", "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n";
      }
      if (argv[0] === "list-sessions") return "";
      if (argv[0] === "list-panes") return `${applicationShellPaneWire("runtime:session")}\n`;
      return "";
    };
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: execute,
      readCommandExecutor: asyncRead(execute),
      agentStatusProbe: {
        async probe(input) {
          probed.push({ sessionId: input.sessionId, panes: input.panes });
          return new Map(
            input.panes.map((pane) => [
              pane.runtimePaneId,
              {
                agentStateRaw: `blocked:${input.nowSec}`,
                agentStatusTextRaw: "waiting on you",
                agentDisplayNameRaw: "Codex",
                agentScrapeState: null,
              },
            ]),
          );
        },
      },
    });

    await runtime.whenReady();
    const session = await runtime.discoverApplicationShellSession("runtime:session");
    expect(session?.panes[0]).toMatchObject({
      runtimePaneId: "%3",
      agentStateRaw: expect.stringMatching(/^blocked:/u),
      agentStatusTextRaw: "waiting on you",
      agentDisplayNameRaw: "Codex",
      agentScrapeState: null,
    });
    // The probe is handed the resolved session id and the discovered pane set.
    expect(probed).toHaveLength(1);
    expect(probed[0]!.sessionId).toBe("$7");
    expect(probed[0]!.panes.map((pane) => pane.runtimePaneId)).toEqual(["%3"]);
    await runtime.dispose();
  });

  it("accepts no default tmux server only for construction with an empty registry", async () => {
    const { registry, root } = createEmptyRegistry();
    const calls: string[][] = [];
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: {
        ...authority(root),
        socketSelector: { kind: "name", name: "default" },
      },
      commandExecutor: (_executable, argv) => {
        calls.push([...argv]);
        throw new TmuxError("raw default socket detail", "TMUX_UNAVAILABLE");
      },
    });

    await expect(runtime.whenReady()).resolves.toBeUndefined();
    expect(calls).toEqual([
      [
        "-L",
        "default",
        "list-sessions",
        "-F",
        "#{session_name}|tmux-ide-view-field-v1|#{session_id}",
      ],
    ]);
    await runtime.dispose();
  });

  it("accepts no default tmux server with a nonempty durable registry", async () => {
    const { registry, root } = createRegistry();
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: {
        ...authority(root),
        socketSelector: { kind: "name", name: "default" },
      },
      commandExecutor: () => {
        throw new TmuxError("raw unavailable default socket detail", "TMUX_UNAVAILABLE");
      },
    });

    await expect(runtime.whenReady()).resolves.toBeUndefined();
    await runtime.dispose();
  });

  it("fails startup closed for an unavailable explicit named socket", async () => {
    const { registry, root } = createEmptyRegistry();
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: {
        ...authority(root),
        socketSelector: { kind: "name", name: "explicit-runtime" },
      },
      commandExecutor: () => {
        throw new TmuxError("raw inaccessible named socket detail", "TMUX_UNAVAILABLE");
      },
    });

    await expect(runtime.whenReady()).rejects.toMatchObject({
      code: "orphan-reconciliation-failed",
      message: "Daemon-owned terminal view startup reconciliation failed.",
    });
    await runtime.dispose();
  });

  it("fails startup closed for an unavailable explicit socket path", async () => {
    const { registry, root } = createEmptyRegistry();
    const socketPath = join(root, "explicit.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const runtime = createNativeTerminalAttachmentRuntime({
        daemonInstanceId: INSTANCE_ID,
        webSocketUrl: WS_URL,
        registry,
        tmuxAuthority: {
          ...authority(root),
          socketSelector: { kind: "path", path: socketPath },
        },
        commandExecutor: () => {
          throw new TmuxError("raw inaccessible path detail", "TMUX_UNAVAILABLE");
        },
      });

      await expect(runtime.whenReady()).rejects.toMatchObject({
        code: "orphan-reconciliation-failed",
        message: "Daemon-owned terminal view startup reconciliation failed.",
      });
      await runtime.dispose();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("cleans strictly marked orphan views before an issue can resolve", async () => {
    const { registry, root } = createRegistry();
    const events: string[] = [];
    const model = new StartupReconciliationTmuxModel(events);
    const catalog = new SemanticPaneCatalog({
      discover: () => {
        events.push("discover-pane-for-issue");
        return [row()];
      },
    });
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: authority(root),
      semanticPaneCatalog: catalog,
      commandExecutor: model.execute,
      lease: {
        createId: () => LEASE_ID,
        randomBytes: () => Buffer.alloc(32, 7),
      },
    });

    const issuing = runtime.admission.issue(request(), {
      requestId: REQUEST_ID,
      projectIdentity: "project-alpha",
      rendererOrigin: ORIGIN,
    });
    expect(
      runtime.admission.reserveUpgrade({
        path: TERMINAL_ATTACHMENT_REDEEM_PATH,
        protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
        origin: ORIGIN,
      }),
    ).toEqual({ accepted: false, code: "attachment-unavailable", httpStatus: 503 });

    await expect(runtime.whenReady()).resolves.toBeUndefined();
    await expect(issuing).resolves.toMatchObject({ requestId: REQUEST_ID });
    expect(model.viewExists).toBe(false);
    expect(events).toEqual(["enumerate-orphans", "cleanup-orphan", "discover-pane-for-issue"]);
    await runtime.dispose();
  });

  it("fails readiness and issue admission closed when orphan cleanup fails", async () => {
    const { registry, root } = createRegistry();
    const events: string[] = [];
    const model = new StartupReconciliationTmuxModel(events);
    model.cleanupFailure = true;
    const catalog = new SemanticPaneCatalog({
      discover: () => {
        events.push("unexpected-pane-discovery");
        return [row()];
      },
    });
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: authority(root),
      semanticPaneCatalog: catalog,
      commandExecutor: model.execute,
      lease: {
        createId: () => LEASE_ID,
        randomBytes: () => Buffer.alloc(32, 7),
      },
    });

    await expect(runtime.whenReady()).rejects.toMatchObject({
      code: "orphan-reconciliation-failed",
      message: "Daemon-owned terminal view startup reconciliation failed.",
    });
    await expect(
      runtime.admission.issue(request(), {
        requestId: REQUEST_ID,
        projectIdentity: "project-alpha",
        rendererOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({
      code: "attachment-unavailable",
      message: "Terminal attachment startup reconciliation failed.",
    });
    expect(events).toEqual(["enumerate-orphans", "cleanup-orphan"]);
    expect(runtime.snapshot()).toMatchObject({ pendingTickets: 0, liveConnections: 0 });
    await runtime.dispose();
  });

  it("disposes through initialization and never reports late readiness", async () => {
    const { registry, root } = createRegistry();
    const model = new StartupReconciliationTmuxModel();
    model.viewExists = false;
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: authority(root),
      semanticPaneCatalog: new SemanticPaneCatalog({ discover: () => [row()] }),
      commandExecutor: model.execute,
    });

    const readiness = runtime.whenReady();
    const disposing = runtime.dispose();
    expect(runtime.dispose()).toBe(disposing);
    await expect(readiness).rejects.toMatchObject({ code: "runtime-disposed" });
    await disposing;
    expect(model.events).toEqual(["enumerate-orphans"]);
    expect(runtime.snapshot()).toEqual({
      pendingTickets: 0,
      preAuthSockets: 0,
      liveConnections: 0,
      shuttingDown: true,
    });
  });

  it("does not finish an issue across shutdown and returns one complete dispose barrier", async () => {
    const { registry, root } = createRegistry();
    let releaseDiscovery!: () => void;
    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      discoveryStarted = resolve;
    });
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const catalog = new SemanticPaneCatalog({
      discover: async () => {
        discoveryStarted();
        await discoveryGate;
        return [row()];
      },
    });
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: authority(root),
      semanticPaneCatalog: catalog,
      commandExecutor: () => "",
      lease: {
        createId: () => LEASE_ID,
        randomBytes: () => Buffer.alloc(32, 7),
      },
    });
    const issuing = runtime.admission.issue(request(), {
      requestId: REQUEST_ID,
      projectIdentity: "project-alpha",
      rendererOrigin: ORIGIN,
    });
    await started;
    const firstDispose = runtime.dispose();
    expect(runtime.dispose()).toBe(firstDispose);
    releaseDiscovery();

    await expect(issuing).rejects.toMatchObject({ code: "daemon-shutting-down" });
    await firstDispose;
    expect(runtime.snapshot()).toEqual({
      pendingTickets: 0,
      preAuthSockets: 0,
      liveConnections: 0,
      shuttingDown: true,
    });
  });

  it("kills a launch awaiting readiness and cannot publish a late live PTY after dispose", async () => {
    const { registry, root } = createRegistry();
    const adapter = new MockPtyAdapter({ startingPid: 4321 });
    const model = new RuntimeTmuxModel(adapter);
    const catalog = new SemanticPaneCatalog({ discover: () => [row()] });
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: authority(root),
      semanticPaneCatalog: catalog,
      commandExecutor: model.execute,
      ptyAdapter: adapter,
      lease: {
        createId: () => LEASE_ID,
        randomBytes: () => Buffer.alloc(32, 7),
      },
      launcher: { readinessTimeoutMs: 5_000, readinessPollIntervalMs: 10 },
    });
    const issued = await runtime.admission.issue(request(), {
      requestId: REQUEST_ID,
      projectIdentity: "project-alpha",
      rendererOrigin: ORIGIN,
    });
    expect(JSON.stringify(runtime)).toBe(
      '{"pendingTickets":1,"preAuthSockets":0,"liveConnections":0,"shuttingDown":false}',
    );
    const upgrade = runtime.admission.reserveUpgrade({
      path: TERMINAL_ATTACHMENT_REDEEM_PATH,
      protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
      origin: ORIGIN,
    });
    if (!upgrade.accepted) throw new Error(upgrade.code);
    const socket = new FakeSocket();
    upgrade.admission.bind(socket);
    socket.frame(
      JSON.stringify({
        type: "redeem",
        protocolVersion: 1,
        ticket: issued.redemptionTicket,
        requestId: REQUEST_ID,
        daemonInstanceId: INSTANCE_ID,
      }),
    );
    await vi.waitFor(() => expect(adapter.spawnCount).toBe(1));
    const process = adapter.lastSpawned()!;
    const disposing = runtime.dispose();
    model.proofReady = true;
    await disposing;

    expect(process.killed).toBe("SIGTERM");
    expect(adapter.spawnCount).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      pendingTickets: 0,
      preAuthSockets: 0,
      liveConnections: 0,
      shuttingDown: true,
    });
    for (const environment of model.environments) {
      expect(environment).toEqual({ TERM: "screen-256color", LANG: "C" });
    }
  });

  it("invalidates standalone reads on registry changes without a session runtime registry", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let calls = 0;
    let firstStarted!: () => void;
    const didStart = new Promise<void>((resolve) => (firstStarted = resolve));
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: () => "",
      readCommandExecutor: async (_executable, rawArgv, options) => {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          await new Promise<never>((_resolve, reject) =>
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          );
        }
        const argv = rawArgv.slice(2);
        if (argv[0] === "list-sessions") {
          return registry
            .list()
            .map((workspace, index) =>
              [workspace.sessionName, `$${index + 7}`, "tmux-ide-session-v2"].join(
                INVENTORY_SEPARATOR,
              ),
            )
            .join("\n");
        }
        const target = argv[argv.indexOf("-t") + 1];
        const index = registry.list().findIndex((_entry, row) => `$${row + 7}` === target);
        const workspace = registry.list()[index]!;
        return `${applicationShellPaneWire(workspace.sessionName)
          .replace("$7", target!)
          .replace("@2", `@${index + 2}`)
          .replace("%3", `%${index + 3}`)}\n`;
      },
    });
    await runtime.whenReady();
    const pending = runtime.discoverTerminalInventory();
    await didStart;
    registry.add({
      name: "workspace.beta",
      sessionName: "runtime:beta",
      projectDir: root,
      persistence: "volatile",
    });
    const inventory = await pending;
    expect(inventory.panes.map((pane) => pane.sessionName).sort()).toEqual([
      "runtime:beta",
      "runtime:session",
    ]);
    expect(calls).toBe(6);
    await runtime.dispose();
  });

  it("aborts and awaits standalone reads on dispose, then rejects post-dispose reads", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    let calls = 0;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => (started = resolve));
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: authority(root),
      commandExecutor: () => "",
      readCommandExecutor: async (_executable, _argv, options) => {
        calls += 1;
        started();
        return new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      },
    });
    await runtime.whenReady();
    const pending = runtime.discoverApplicationShellSession("runtime:session");
    await didStart;
    await runtime.dispose();
    await expect(pending).rejects.toMatchObject({ code: "runtime-disposed" });
    expect(calls).toBe(1);
    await expect(runtime.discoverTerminalInventory()).rejects.toMatchObject({
      code: "runtime-disposed",
    });
    await expect(runtime.discoverApplicationShellSession("runtime:session")).rejects.toMatchObject({
      code: "runtime-disposed",
    });
  });
});
