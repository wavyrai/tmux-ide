import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  it("maps semantic workspace name to a distinct exact tmux session name", async () => {
    const { registry } = createRegistry("workspace.alpha", "runtime-session-different");
    const calls: string[][] = [];
    const runner: TmuxAttachmentCommandRunner = {
      run(command) {
        calls.push([...command.argv]);
        return {
          status: "ok",
          stdout: "runtime-session-different\t$1\t@2\t%3\t1\t2\tpane.agent\n",
        };
      },
    };
    const catalog = new SemanticPaneCatalog({
      discover: () => discoverWorkspaceRegistrySemanticPanes(registry, runner),
    });

    await expect(catalog.resolve(request().target)).resolves.toMatchObject({
      target: request().target,
      source: { sessionId: "$1", windowId: "@2", runtimePaneId: "%3" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("=runtime-session-different");
    expect(calls[0]).not.toContain("=workspace.alpha");
  });

  it.each([
    ["missing stamp", "runtime-session\t$1\t@2\t%3\t1\t2\t\n", "missing-semantic-stamp"],
    [
      "duplicate stamp",
      "runtime-session\t$1\t@2\t%3\t1\t2\tpane.agent\nruntime-session\t$1\t@4\t%5\t1\t2\tpane.agent\n",
      "duplicate-semantic-stamp",
    ],
  ])("rejects %s from exact registry-backed discovery", async (_label, stdout, code) => {
    const { registry } = createRegistry();
    const catalog = new SemanticPaneCatalog({
      discover: () =>
        discoverWorkspaceRegistrySemanticPanes(registry, {
          run: () => ({ status: "ok", stdout }),
        }),
    });
    await expect(catalog.resolve(request().target)).rejects.toMatchObject({ code });
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

describe("native terminal attachment runtime lifecycle", () => {
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
