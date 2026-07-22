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
  createNativeTerminalAttachmentRuntime,
  discoverWorkspaceRegistryTerminalInventory,
  discoverWorkspaceRegistrySemanticPanes,
  type NativeTerminalAttachmentCommandExecutor,
} from "../attachments/native-runtime.ts";
import {
  SemanticPaneCatalog,
  type TrustedSemanticPaneSnapshot,
} from "../attachments/semantic-pane-catalog.ts";
import {
  TmuxAttachmentOperationSerializer,
  type TmuxAttachmentCommandRunner,
} from "../attachments/tmux-view-executor.ts";
import { MockPtyAdapter } from "./MockPtyAdapter.ts";

const INSTANCE_ID = "daemon-instance-a1";
const REQUEST_ID = "25f3e0c9-00eb-434a-9c90-d59f6f62facf";
const LEASE_ID = "f3d8bc0b-460c-458c-b9c0-dbc2536d1486";
const ATTEMPT_ID = "a45072f8-5a82-4930-8bed-0959c617e60b";
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

function applicationShellPaneWire(
  sessionName: string,
  options: { stamp?: string; paneId?: string } = {},
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
    "teammate",
    "Codex",
    "agent",
    "/repo",
    "tmux-ide-pane-v2",
  ].join(INVENTORY_SEPARATOR);
}

function request(): TerminalAttachRequest {
  return {
    protocolVersion: 1,
    target: { workspaceName: "workspace.alpha", semanticPaneId: "pane.agent" },
    viewerMode: "interactive",
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
      active?: boolean;
    } = {},
  ): string {
    return [
      sessionName,
      "$1",
      options.windowId ?? "@2",
      options.paneId ?? "%3",
      "1",
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
      "/repo",
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

describe("native terminal attachment runtime lifecycle", () => {
  it("uses the pinned executable and custom socket for exact application-shell inventory", async () => {
    const { registry, root } = createRegistry("workspace.alpha", "runtime:session");
    const calls: Array<{ executable: string; argv: readonly string[] }> = [];
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: {
        ...authority(root),
        socketSelector: { kind: "name", name: "inventory-socket" },
      },
      commandExecutor: (executable, rawArgv) => {
        calls.push({ executable, argv: [...rawArgv] });
        const argv = rawArgv.slice(2);
        if (argv[0] === "list-sessions" && argv.at(-1)?.includes("tmux-ide-session-v2")) {
          return ["runtime:session", "$7", "tmux-ide-session-v2"].join(INVENTORY_SEPARATOR) + "\n";
        }
        if (argv[0] === "list-sessions") return "";
        if (argv[0] === "list-panes") {
          expect(argv[argv.indexOf("-t") + 1]).toBe("$7");
          return `${applicationShellPaneWire("runtime:session")}\n`;
        }
        return "";
      },
    });

    await runtime.whenReady();
    await expect(runtime.discoverApplicationShellSession("workspace.alpha")).resolves.toBeNull();
    await expect(runtime.discoverApplicationShellSession("runtime:session")).resolves.toMatchObject(
      {
        name: "runtime:session",
        runtimeSessionId: "$7",
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

    registry.add({ name: "workspace.beta", sessionName: "runtime:session", projectDir: root });
    await expect(runtime.discoverApplicationShellSession("runtime:session")).rejects.toMatchObject({
      code: "discovery-failed",
    });
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

  it.each([
    ["a nonempty registry on the default socket", true, "default"],
    ["an empty registry on a non-default named socket", false, "explicit-runtime"],
  ])("fails startup closed for %s", async (_label, nonempty, socketName) => {
    const { registry, root } = nonempty ? createRegistry() : createEmptyRegistry();
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: INSTANCE_ID,
      webSocketUrl: WS_URL,
      registry,
      tmuxAuthority: {
        ...authority(root),
        socketSelector: { kind: "name", name: socketName },
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
});
