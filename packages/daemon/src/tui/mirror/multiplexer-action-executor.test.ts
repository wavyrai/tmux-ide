import { describe, expect, it, vi } from "vitest";

import { DAEMON_WIRE_PROTOCOL_VERSION, type CanonicalDaemonInfo } from "@tmux-ide/contracts";

import { CliActionInvocationError } from "../../lib/cli-action-bridge.ts";
import type { SessionPaneDescriptor } from "../../terminal/protocol/session-descriptor-discovery.ts";
import { executeTuiMultiplexerAction } from "./multiplexer-action-executor.ts";

const INSTANCE = "20000000-0000-4000-8000-000000000002";
const OPERATION = "10000000-0000-4000-8000-000000000001";

const canonical: CanonicalDaemonInfo = {
  pid: process.pid,
  port: 6060,
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: INSTANCE,
  startedAt: "2026-08-07T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner-token",
};

const descriptors: readonly SessionPaneDescriptor[] = [
  {
    runtimePaneId: "%1",
    semanticPaneId: "pane.source",
    role: null,
    type: null,
    currentCommand: "zsh",
    cwd: "/workspace",
    title: "Editor",
    windowIndex: 0,
    windowName: "main",
    windowId: "@1",
  },
  {
    runtimePaneId: "%2",
    semanticPaneId: "pane.target",
    role: null,
    type: null,
    currentCommand: "zsh",
    cwd: "/workspace",
    title: "Shell",
    windowIndex: 0,
    windowName: "main",
    windowId: "@1",
  },
];

function context() {
  return {
    sessionName: "renamed-session",
    focusedRuntimePaneId: "%1",
    paneDescriptors: descriptors,
  } as const;
}

function catalog(instanceId = INSTANCE): Response {
  return Response.json({
    version: 1,
    daemon: {
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId,
      startedAt: canonical.startedAt,
    },
    workspaces: [
      {
        workspaceName: "project-stable-identity",
        sessionName: "renamed-session",
      },
    ],
  });
}

describe("TUI multiplexer action executor", () => {
  it("uses raw control-mode tmux only when no canonical daemon exists", async () => {
    const runLocal = vi.fn(async () => undefined);
    const dispatchAction = vi.fn();

    await expect(
      executeTuiMultiplexerAction({ kind: "split-pane-right" }, context(), runLocal, {
        readCanonicalDaemonInfo: () => null,
        dispatchAction: dispatchAction as never,
      }),
    ).resolves.toEqual({ status: "local", message: "split pane right" });

    expect(runLocal).toHaveBeenCalledWith('split-window -h -t %1 -c "#{pane_current_path}"');
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("resolves a renamed session through the generation-stamped catalog before dispatch", async () => {
    const dispatchAction = vi.fn(async () => ({ outcome: "applied" }));
    const runLocal = vi.fn(async () => undefined);

    await expect(
      executeTuiMultiplexerAction({ kind: "split-pane-down" }, context(), runLocal, {
        readCanonicalDaemonInfo: () => canonical,
        isCanonicalDaemonAlive: async () => true,
        fetch: vi.fn(async () => catalog()) as typeof fetch,
        dispatchAction: dispatchAction as never,
        operationId: () => OPERATION,
      }),
    ).resolves.toEqual({ status: "daemon", message: "split pane down" });

    expect(dispatchAction).toHaveBeenCalledWith(
      "workspace.window.split",
      {
        workspaceName: "project-stable-identity",
        semanticPaneId: "pane.source",
        direction: "down",
      },
      { operationId: OPERATION, autostart: false },
    );
    expect(runLocal).not.toHaveBeenCalled();
  });

  it("swaps durable semantic pane identities instead of runtime pane ids", async () => {
    const dispatchAction = vi.fn(async () => ({ outcome: "applied" }));

    await executeTuiMultiplexerAction({ kind: "swap-pane" }, context(), vi.fn(), {
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
      fetch: vi.fn(async () => catalog()) as typeof fetch,
      dispatchAction: dispatchAction as never,
      operationId: () => OPERATION,
    });

    expect(dispatchAction).toHaveBeenCalledWith(
      "workspace.pane.swap",
      {
        workspaceName: "project-stable-identity",
        sourceSemanticPaneId: "pane.source",
        targetSemanticPaneId: "pane.target",
      },
      { operationId: OPERATION, autostart: false },
    );
  });

  it("routes session-menu rename through the stable workspace identity", async () => {
    const dispatchAction = vi.fn(async () => ({ outcome: "applied" }));

    await expect(
      executeTuiMultiplexerAction(
        { kind: "rename-session", name: "fresh-name" },
        { ...context(), focusedRuntimePaneId: null, paneDescriptors: [] },
        vi.fn(),
        {
          readCanonicalDaemonInfo: () => canonical,
          isCanonicalDaemonAlive: async () => true,
          fetch: vi.fn(async () => catalog()) as typeof fetch,
          dispatchAction: dispatchAction as never,
          operationId: () => OPERATION,
        },
      ),
    ).resolves.toEqual({ status: "daemon", message: "renamed session → fresh-name" });

    expect(dispatchAction).toHaveBeenCalledWith(
      "workspace.rename",
      {
        workspaceName: "project-stable-identity",
        scope: "session",
        name: "fresh-name",
      },
      { operationId: OPERATION, autostart: false },
    );
  });

  it("surfaces a typed daemon refusal without bypassing it locally", async () => {
    const runLocal = vi.fn(async () => undefined);
    const dispatchAction = vi.fn(async () => {
      throw new CliActionInvocationError({
        code: "bad_request",
        message: "This is the session's last window. Close the session instead.",
      });
    });

    await expect(
      executeTuiMultiplexerAction({ kind: "kill-window" }, context(), runLocal, {
        readCanonicalDaemonInfo: () => canonical,
        isCanonicalDaemonAlive: async () => true,
        fetch: vi.fn(async () => catalog()) as typeof fetch,
        dispatchAction: dispatchAction as never,
      }),
    ).resolves.toEqual({
      status: "error",
      message: "This is the session's last window. Close the session instead.",
    });
    expect(runLocal).not.toHaveBeenCalled();
  });

  it("fails closed when semantic identity or daemon generation is unavailable", async () => {
    const runLocal = vi.fn(async () => undefined);
    const noIdentity = {
      ...context(),
      paneDescriptors: descriptors.map((descriptor) => ({
        ...descriptor,
        semanticPaneId: null,
      })),
    };

    const missingIdentity = await executeTuiMultiplexerAction(
      { kind: "kill-pane" },
      noIdentity,
      runLocal,
      {
        readCanonicalDaemonInfo: () => canonical,
        isCanonicalDaemonAlive: async () => true,
        fetch: vi.fn(async () => catalog()) as typeof fetch,
        dispatchAction: vi.fn() as never,
      },
    );
    expect(missingIdentity).toEqual({
      status: "error",
      message:
        "tmux action unavailable: the active pane does not have a durable semantic identity yet",
    });

    const generationChanged = await executeTuiMultiplexerAction(
      { kind: "new-window" },
      context(),
      runLocal,
      {
        readCanonicalDaemonInfo: () => canonical,
        isCanonicalDaemonAlive: async () => true,
        fetch: vi.fn(async () => catalog("30000000-0000-4000-8000-000000000003")) as typeof fetch,
        dispatchAction: vi.fn() as never,
      },
    );
    expect(generationChanged).toEqual({
      status: "error",
      message: "tmux action unavailable: daemon generation changed while resolving the workspace",
    });
    expect(runLocal).not.toHaveBeenCalled();
  });
});
