import { describe, expect, it, vi } from "vitest";

import { DAEMON_WIRE_PROTOCOL_VERSION, type CanonicalDaemonInfo } from "@tmux-ide/contracts";

import {
  __setCliActionBridgeDepsForTests,
  CliActionInvocationError,
  tryDispatchAction,
} from "./cli-action-bridge.ts";
import { createApp } from "../command-center/server.ts";

const OPERATION = "10000000-0000-4000-8000-000000000001";
const INSTANCE = "20000000-0000-4000-8000-000000000002";

describe("CLI owner action bridge", () => {
  it("keeps a queued local action alive beyond the old two-second deadline", async () => {
    vi.useFakeTimers();
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    let settle: ((response: Response) => void) | null = null;
    let requestSignal: AbortSignal | null = null;
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return new Promise<Response>((resolve, reject) => {
        settle = resolve;
        requestSignal?.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      });
    });
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      const dispatched = tryDispatchAction(
        "workspace.pane.send",
        {
          workspaceName: "workspace.alpha",
          semanticPaneId: "pane.target",
          text: "hello",
          submit: true,
          origin: "cli",
        },
        { operationId: OPERATION, autostart: false },
      );
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(requestSignal?.aborted).toBe(false);
      settle?.(
        Response.json({
          ok: true,
          result: {
            verb: "workspace.pane.send",
            outcome: "applied",
            operationId: OPERATION,
            daemonInstanceId: INSTANCE,
            workspaceName: "workspace.alpha",
            sourceSemanticPaneId: null,
            semanticPaneId: "pane.target",
            origin: "cli",
            characterCount: 5,
            byteCount: 5,
            submitted: true,
          },
        }),
      );
      await expect(dispatched).resolves.toMatchObject({ operationId: OPERATION });
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("shares one overall deadline across same-operation retries", async () => {
    vi.useFakeTimers();
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing action deadline");
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new Error("connection lost after commit")), 6_000);
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("operation deadline")), {
          once: true,
        });
      });
    });
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      const dispatched = tryDispatchAction(
        "workspace.pane.send",
        {
          workspaceName: "workspace.alpha",
          semanticPaneId: "pane.target",
          text: "hello",
          submit: true,
          origin: "cli",
        },
        { operationId: OPERATION, autostart: false },
      );
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(signals[1]).toBe(signals[0]);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(dispatched).resolves.toBeNull();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("keeps a daemon rejection typed instead of treating it as transport loss", async () => {
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const restore = __setCliActionBridgeDepsForTests({
      fetch: (async () =>
        Response.json({
          ok: false,
          error: { code: "pane_not_found", message: "Pane is gone" },
        })) as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      const rejected = tryDispatchAction(
        "workspace.pane.send",
        {
          workspaceName: "workspace.alpha",
          semanticPaneId: "pane.target",
          text: "hello",
          submit: true,
          origin: "cli",
        },
        { operationId: OPERATION, autostart: false },
      );
      await expect(rejected).rejects.toMatchObject({
        name: CliActionInvocationError.name,
        code: "pane_not_found",
      });
    } finally {
      restore();
    }
  });

  it("carries a pane credential only in the dedicated request header", async () => {
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    let captured: RequestInit | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return Response.json({
        ok: true,
        result: {
          verb: "workspace.pane.send",
          outcome: "applied",
          operationId: OPERATION,
          daemonInstanceId: INSTANCE,
          workspaceName: "workspace.alpha",
          sourceSemanticPaneId: "pane.source",
          semanticPaneId: "pane.target",
          origin: "cli",
          characterCount: 5,
          byteCount: 5,
          submitted: true,
        },
      });
    });
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      await tryDispatchAction(
        "workspace.pane.send",
        {
          workspaceName: "workspace.alpha",
          sourceSemanticPaneId: "pane.source",
          semanticPaneId: "pane.target",
          text: "hello",
          submit: true,
          origin: "cli",
        },
        {
          operationId: OPERATION,
          autostart: false,
          sourcePaneCredential: "opaque-pane-credential",
        },
      );
    } finally {
      restore();
    }
    const headers = new Headers(captured?.headers);
    expect(headers.get("x-tmux-ide-pane-source-credential")).toBe("opaque-pane-credential");
    expect(JSON.parse(String(captured?.body))).not.toHaveProperty("sourcePaneCredential");
  });

  it("does not autostart a daemon when an interactive caller requests canonical-only dispatch", async () => {
    const startEmbeddedDaemon = vi.fn();
    const restore = __setCliActionBridgeDepsForTests({
      readCanonicalDaemonInfo: () => null,
      startEmbeddedDaemon,
    });
    try {
      await expect(
        tryDispatchAction(
          "workspace.window.split",
          {
            workspaceName: "workspace.alpha",
            semanticPaneId: "pane.source",
            direction: "right",
          },
          { operationId: OPERATION, autostart: false },
        ),
      ).resolves.toBeNull();
    } finally {
      restore();
    }
    expect(startEmbeddedDaemon).not.toHaveBeenCalled();
  });

  it("gives multiplexer verbs one stable owner operation id across retry", async () => {
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const requests: RequestInit[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      if (requests.length === 1) throw new Error("connection closed after commit");
      return Response.json({
        ok: true,
        result: {
          operationId: OPERATION,
          daemonInstanceId: INSTANCE,
          outcome: "replayed",
          workspaceName: "workspace.alpha",
          verb: "workspace.window.split",
          direction: "right",
          semanticPaneId: "pane.created",
          displayTitle: "Terminal",
        },
      });
    });
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      await expect(
        tryDispatchAction(
          "workspace.window.split",
          {
            workspaceName: "workspace.alpha",
            semanticPaneId: "pane.source",
            direction: "right",
          },
          { operationId: OPERATION, autostart: false },
        ),
      ).resolves.toMatchObject({ outcome: "replayed", operationId: OPERATION });
    } finally {
      restore();
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const headers = new Headers(request.headers);
      expect(headers.get("authorization")).toBe("Bearer owner-only-token");
      expect(headers.get("x-tmux-ide-operation-id")).toBe(OPERATION);
    }
  });

  it("uses the owner-only token and one stable operation id across retry", async () => {
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      if (requests.length === 1) {
        return { json: async () => Promise.reject(new Error("truncated body after commit")) };
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            operationId: OPERATION,
            daemonInstanceId: INSTANCE,
            outcome: "replayed",
            resource: {
              resourceVersion: 1,
              workspaceName: "workspace.alpha",
              semanticPaneId: "pane.10000000000040008000000000000001",
              kind: "terminal",
              displayTitle: "Terminal",
              harnessProfileId: null,
              role: null,
              missionId: null,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      await expect(
        tryDispatchAction(
          "workspace.pane.create",
          { kind: "terminal", workspaceName: "workspace.alpha" },
          { operationId: OPERATION },
        ),
      ).resolves.toMatchObject({ operationId: OPERATION, outcome: "replayed" });
    } finally {
      restore();
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const headers = new Headers(request.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer owner-only-token");
      expect(headers.get("x-tmux-ide-operation-id")).toBe(OPERATION);
    }
  });

  it("retries workspace.open with its stable owner correlation id and strict result contract", async () => {
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const requests: RequestInit[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      if (requests.length === 1) throw new Error("connection closed after commit");
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            operationId: OPERATION,
            daemonInstanceId: INSTANCE,
            outcome: "replayed",
            resource: {
              resourceVersion: 1,
              workspaceName: "project-00112233445566778899aabbccddeeff",
              initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      await expect(
        tryDispatchAction(
          "workspace.open",
          { projectDir: "/canonical/project" },
          { operationId: OPERATION },
        ),
      ).resolves.toMatchObject({ operationId: OPERATION, outcome: "replayed" });
    } finally {
      restore();
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const headers = new Headers(request.headers);
      expect(headers.get("authorization")).toBe("Bearer owner-only-token");
      expect(headers.get("x-tmux-ide-operation-id")).toBe(OPERATION);
    }
  });

  it("passes workspace.open end-to-end through the owner gate and dispatcher", async () => {
    const open = vi.fn(async (request) => ({
      operationId: request.operationId,
      daemonInstanceId: request.expectedDaemonInstanceId,
      outcome: "created" as const,
      resource: {
        resourceVersion: 1 as const,
        workspaceName: "project-00112233445566778899aabbccddeeff",
        initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
      },
    }));
    const app = createApp({
      remoteAccess: { ownerToken: "owner-only-token" },
      daemonIdentity: {
        productVersion: "2.8.0",
        instanceId: INSTANCE,
        startedAt: "2026-07-22T00:00:00.000Z",
      },
      workspaceOpenBackend: { open },
    });
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      app.request(typeof input === "string" ? input : input.toString(), init),
    );
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      await expect(
        tryDispatchAction(
          "workspace.open",
          { projectDir: "/canonical/project" },
          { operationId: OPERATION },
        ),
      ).resolves.toMatchObject({ operationId: OPERATION, outcome: "created" });
    } finally {
      restore();
    }
    expect(open).toHaveBeenCalledWith({
      operationId: OPERATION,
      expectedDaemonInstanceId: INSTANCE,
      intent: { projectDir: "/canonical/project" },
    });
  });
});
