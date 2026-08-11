import type {
  PushResourceSessionAdapter,
  PushResourceSessionOptions,
} from "@tmux-ide/daemon-client/push-resource-session";
import { createPushResourceSession } from "@tmux-ide/daemon-client/push-resource-session";
import { describe, expect, it, vi } from "vitest";

import {
  createTuiToolResourceAdapter,
  createTuiToolResourceController,
  type TuiToolResource,
  type TuiToolResourceFailure,
  type TuiToolResourceKey,
  type TuiToolResourceTarget,
} from "./tool-resource-controller.ts";

const DAEMON = {
  pid: 42,
  port: 4040,
  protocolVersion: 1,
  productVersion: "test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-12T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner",
} as const;

const TARGET: TuiToolResourceTarget = { daemon: DAEMON, workspaceName: "workspace.one" };

function fakeAdapter(log: string[]) {
  const updates: string[][] = [];
  const adapter: PushResourceSessionAdapter<
    TuiToolResourceTarget,
    TuiToolResourceKey,
    TuiToolResource,
    TuiToolResourceFailure
  > = {
    validateTarget(value) {
      return value === null
        ? {
            ok: false,
            failure: { code: "target-invalid", message: "missing", retryable: false },
          }
        : { ok: true, target: value as TuiToolResourceTarget, key: "target" };
    },
    async fetch(_target, key) {
      log.push(`fetch:${key}`);
      return {
        status: "failed",
        failure: { code: "unavailable", message: "fixture", retryable: false },
      };
    },
    connect(_target, interests, _handlers, _signal) {
      updates.push([...interests].sort());
      return {
        status: "connected",
        close: vi.fn(),
        updateInterests(next) {
          updates.push([...next].sort());
        },
      };
    },
    rejectionFailure: () => ({ code: "unavailable", message: "rejected", retryable: false }),
    retryable: (value) => value.retryable,
    interestKey: (key) =>
      ({
        fleet: "fleet-catalog",
        sessions: "workspace-catalog",
        projects: "workspace-catalog",
        files: "workspace-files",
        changes: "workspace-changes",
        missions: "workspace-missions",
      })[key],
  };
  return { adapter, updates };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("OpenTUI demand-driven tool resources", () => {
  it("does no fetch, subprocess, or maintenance timer work across ten idle minutes", () => {
    const log: string[] = [];
    const { adapter } = fakeAdapter(log);
    let now = 0;
    const timers: Array<{ callback: () => void; at: number }> = [];
    const options: PushResourceSessionOptions = {
      clock: {
        now: () => now,
        setTimeout(callback, delayMs) {
          timers.push({ callback, at: now + delayMs });
          return callback;
        },
        clearTimeout: vi.fn(),
      },
    };
    const controller = createTuiToolResourceController(adapter, options);
    controller.setTarget(TARGET);
    controller.setOpenDock("files");
    now += 10 * 60 * 1_000;

    expect(timers).toEqual([]);
    expect(log).toEqual([]);
    expect(controller.getMetrics()).toMatchObject({
      toolFetches: 0,
      subprocessLaunches: 0,
      activeInterests: 0,
    });
    controller.dispose();
  });

  it("admits tool demand only after terminal readiness", async () => {
    const log: string[] = [];
    const { adapter } = fakeAdapter(log);
    const controller = createTuiToolResourceController(adapter);
    controller.setTarget(TARGET);
    controller.setOpenDock("files");
    expect(log).toEqual([]);

    log.push("terminal-ready");
    controller.markTerminalReady();
    await settle();

    expect(log[0]).toBe("terminal-ready");
    expect(new Set(log.slice(1))).toEqual(
      new Set(["fetch:fleet", "fetch:sessions", "fetch:projects", "fetch:files"]),
    );
    controller.dispose();
  });

  it("moves one dock interest Files to Changes and releases it when collapsed", async () => {
    const log: string[] = [];
    const { adapter, updates } = fakeAdapter(log);
    const controller = createTuiToolResourceController(adapter);
    controller.setTarget(TARGET);
    controller.setOpenDock("files");
    controller.markTerminalReady();
    await settle();
    controller.setOpenDock("changes");
    await settle();
    controller.setOpenDock(null);
    await settle();

    expect(updates).toContainEqual(["fleet-catalog", "workspace-catalog", "workspace-files"]);
    expect(updates).toContainEqual(["fleet-catalog", "workspace-catalog", "workspace-changes"]);
    expect(updates.at(-1)).toEqual(["fleet-catalog", "workspace-catalog"]);
    controller.dispose();
  });
});

class FakeSocket {
  readonly sent: string[] = [];
  readonly close = vi.fn();
  readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

describe("OpenTUI semantic event adapter", () => {
  it("installs the combined global catalogs before their first reads", async () => {
    const socket = new FakeSocket();
    const fetched: string[] = [];
    const adapter = createTuiToolResourceAdapter({
      createSocket: () => socket,
      fetch: async (input) => {
        const url = String(input);
        fetched.push(url);
        if (url.endsWith("/fleet-catalog")) {
          return Response.json({
            version: 1,
            daemon: {
              protocolVersion: DAEMON.protocolVersion,
              productVersion: DAEMON.productVersion,
              instanceId: DAEMON.instanceId,
              startedAt: DAEMON.startedAt,
            },
            sessions: [],
          });
        }
        return Response.json(url.endsWith("/sessions") ? { sessions: [] } : { projects: [] });
      },
    });
    const session = createPushResourceSession(adapter, TARGET, {
      retry: { maximumAttempts: 0 },
    });
    session.activate("fleet");
    session.activate("sessions");
    session.activate("projects");
    await settle();
    socket.emit(
      "message",
      JSON.stringify({
        type: "hello",
        daemon: {
          protocolVersion: 1,
          productVersion: "test",
          instanceId: DAEMON.instanceId,
          startedAt: DAEMON.startedAt,
        },
        sessions: [],
        eventSequence: 0,
      }),
    );
    await settle();
    expect(JSON.parse(socket.sent[0] ?? "null").interests).toEqual([
      { resource: "fleet-catalog", workspaceName: null },
      { resource: "workspace-catalog", workspaceName: null },
    ]);
    expect(fetched).toEqual([]);
    socket.emit(
      "message",
      JSON.stringify({
        type: "resource.interests-ack",
        interestRevision: 1,
        sequence: 0,
        unavailableInterests: [],
      }),
    );
    await vi.waitFor(() => {
      expect(new Set(fetched)).toEqual(
        new Set([
          "http://127.0.0.1:4040/api/resources/fleet-catalog",
          "http://127.0.0.1:4040/api/sessions",
          "http://127.0.0.1:4040/api/projects",
        ]),
      );
    });
    session.dispose();
  });

  it("installs explicit semantic interests before resolving and ignores terminal-only events", async () => {
    const socket = new FakeSocket();
    const invalidate = vi.fn();
    const adapter = createTuiToolResourceAdapter({
      createSocket: () => socket,
    });
    const controller = new AbortController();
    const connecting = adapter.connect(
      TARGET,
      new Set(["workspace-files"]),
      { invalidate },
      controller.signal,
    );
    socket.emit("open");
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "hello",
          daemon: {
            protocolVersion: 1,
            productVersion: "test",
            instanceId: DAEMON.instanceId,
            startedAt: DAEMON.startedAt,
          },
          sessions: [],
          eventSequence: 0,
        }),
      ),
    );
    await settle();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "resource.interests-ack",
          interestRevision: 1,
          sequence: 0,
          unavailableInterests: [],
        }),
      ),
    );
    const connected = await connecting;
    expect(connected).toMatchObject({ status: "connected" });
    expect(JSON.parse(socket.sent[0] ?? "null")).toEqual({
      type: "subscribe",
      sessions: [],
      interests: [{ resource: "workspace-files", workspaceName: "workspace.one" }],
      afterSequence: 0,
      interestRevision: 1,
      legacyEvents: false,
    });

    socket.emit(
      "message",
      JSON.stringify({ type: "terminals.changed", sessionName: "raw-tmux-session" }),
    );
    expect(invalidate).not.toHaveBeenCalled();
    socket.emit(
      "message",
      JSON.stringify({
        type: "resource.changed",
        sequence: 1,
        revision: 1,
        workspaceName: "workspace.one",
        resource: "workspace-files",
        causeOperationId: null,
      }),
    );
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(["files"]);
    if (connected.status === "connected") connected.close();
  });

  it("reconnects one socket, resumes its cursor, and stops retrying after close", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const adapter = createTuiToolResourceAdapter({
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const controller = new AbortController();
      const connecting = adapter.connect(
        TARGET,
        new Set(["workspace-files"]),
        { invalidate: vi.fn() },
        controller.signal,
      );
      await settle();
      expect(sockets).toHaveLength(1);
      const hello = JSON.stringify({
        type: "hello",
        daemon: {
          protocolVersion: 1,
          productVersion: "test",
          instanceId: DAEMON.instanceId,
          startedAt: DAEMON.startedAt,
        },
        sessions: [],
        eventSequence: 0,
      });
      sockets[0]!.emit("message", Buffer.from(hello));
      await settle();
      sockets[0]!.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "resource.interests-ack",
            interestRevision: 1,
            sequence: 0,
            unavailableInterests: [],
          }),
        ),
      );
      const connected = await connecting;
      sockets[0]!.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "resource.observed", sequence: 7 })),
      );
      sockets[0]!.emit("close");
      await vi.advanceTimersByTimeAsync(249);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
      sockets[1]!.emit("message", Buffer.from(hello));
      await settle();
      sockets[1]!.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "resource.interests-ack",
            interestRevision: 2,
            sequence: 7,
            unavailableInterests: [],
          }),
        ),
      );
      await settle();
      expect(JSON.parse(sockets[1]!.sent[0] ?? "null")).toMatchObject({
        type: "subscribe",
        sessions: [],
        afterSequence: 7,
      });
      if (connected.status === "connected") connected.close();
      sockets[1]!.emit("close");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans a failed pre-hello generation and lets only the transport supervisor retry", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const adapter = createTuiToolResourceAdapter({
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const controller = new AbortController();
      const connecting = Promise.resolve(
        adapter.connect(
          TARGET,
          new Set(["workspace-files"]),
          { invalidate: vi.fn() },
          controller.signal,
        ),
      );
      await settle();
      sockets[0]!.emit("close");
      expect([...sockets[0]!.listeners.values()].every((listeners) => listeners.size === 0)).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(249);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
      controller.abort();
      await expect(connecting).rejects.toThrow("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an in-flight ack on a verified socket edge", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const adapter = createTuiToolResourceAdapter({ createSocket: () => socket });
      const controller = new AbortController();
      const connecting = adapter.connect(
        TARGET,
        new Set(["workspace-files"]),
        { invalidate: vi.fn() },
        controller.signal,
      );
      socket.emit(
        "message",
        JSON.stringify({
          type: "hello",
          daemon: {
            protocolVersion: 1,
            productVersion: "test",
            instanceId: DAEMON.instanceId,
            startedAt: DAEMON.startedAt,
          },
          sessions: [],
          eventSequence: 0,
        }),
      );
      await settle();
      socket.emit(
        "message",
        JSON.stringify({
          type: "resource.interests-ack",
          interestRevision: 1,
          sequence: 0,
          unavailableInterests: [],
        }),
      );
      const connected = await connecting;
      expect(connected.status).toBe("connected");
      if (connected.status !== "connected" || !connected.updateInterests) return;
      const updating = connected.updateInterests(new Set(["workspace-changes"]));
      await settle();
      socket.emit("close");
      await expect(updating).rejects.toThrow("closed");
      connected.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a reconnect-window interest update until the next matching ack", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const adapter = createTuiToolResourceAdapter({
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const connecting = adapter.connect(
        TARGET,
        new Set(["workspace-files"]),
        { invalidate: vi.fn() },
        new AbortController().signal,
      );
      const hello = JSON.stringify({
        type: "hello",
        daemon: {
          protocolVersion: 1,
          productVersion: "test",
          instanceId: DAEMON.instanceId,
          startedAt: DAEMON.startedAt,
        },
        sessions: [],
        eventSequence: 0,
      });
      sockets[0]!.emit("message", hello);
      await settle();
      sockets[0]!.emit(
        "message",
        JSON.stringify({
          type: "resource.interests-ack",
          interestRevision: 1,
          sequence: 0,
          unavailableInterests: [],
        }),
      );
      const connected = await connecting;
      if (connected.status !== "connected" || !connected.updateInterests) return;
      sockets[0]!.emit("close");
      const updating = Promise.resolve(connected.updateInterests(new Set(["workspace-changes"])));
      let settled = false;
      void updating.then(() => {
        settled = true;
      });
      await settle();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
      sockets[1]!.emit("message", hello);
      await settle();
      expect(JSON.parse(sockets[1]!.sent[0] ?? "null")).toMatchObject({
        interests: [{ resource: "workspace-changes", workspaceName: "workspace.one" }],
        interestRevision: 2,
      });
      expect(settled).toBe(false);
      sockets[1]!.emit(
        "message",
        JSON.stringify({
          type: "resource.interests-ack",
          interestRevision: 2,
          sequence: 0,
          unavailableInterests: [],
        }),
      );
      await updating;
      expect(settled).toBe(true);
      connected.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a handshake whose interests changed and fetches only the replacement", async () => {
    const sockets: FakeSocket[] = [];
    const fetched: string[] = [];
    const adapter = createTuiToolResourceAdapter({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (input) => {
        fetched.push(String(input));
        return new Response("{}", { status: 500 });
      },
    });
    const session = createPushResourceSession(adapter, TARGET, {
      retry: { maximumAttempts: 0 },
    });
    const releaseFiles = session.activate("files");
    await settle();
    expect(sockets).toHaveLength(1);
    releaseFiles();
    session.activate("changes");
    const hello = JSON.stringify({
      type: "hello",
      daemon: {
        protocolVersion: 1,
        productVersion: "test",
        instanceId: DAEMON.instanceId,
        startedAt: DAEMON.startedAt,
      },
      sessions: [],
      eventSequence: 0,
    });
    sockets[0]!.emit("message", Buffer.from(hello));
    await settle();
    sockets[0]!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "resource.interests-ack",
          interestRevision: 1,
          sequence: 0,
          unavailableInterests: [],
        }),
      ),
    );
    await settle();
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("message", Buffer.from(hello));
    await settle();
    sockets[1]!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "resource.interests-ack",
          interestRevision: 1,
          sequence: 0,
          unavailableInterests: [],
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(fetched).toEqual(["http://127.0.0.1:4040/api/project/workspace.one/changes"]);
    });
    session.dispose();
  });
});
