import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  DaemonSessionMonitor,
  isConfirmedMissingTmuxTarget,
  type DaemonSessionMonitorBackend,
} from "./daemon-session-monitor.ts";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

function backend(
  overrides: Partial<DaemonSessionMonitorBackend> = {},
): DaemonSessionMonitorBackend {
  return {
    inspectSession: vi.fn(async () => "yes"),
    listCredentialSessions: vi.fn(() => []),
    reconcileCredentials: vi.fn(async () => undefined),
    hasClients: vi.fn(async () => false),
    listPanes: vi.fn(async () => []),
    readPortProcessFacts: vi.fn(async () => ({ listeners: new Set(), tree: new Map() })),
    setPaneOption: vi.fn(async () => undefined),
    setPaneTitle: vi.fn(async () => undefined),
    refreshClients: vi.fn(async () => undefined),
    onSessionGone: vi.fn(),
    ...overrides,
  };
}

describe("DaemonSessionMonitor", () => {
  it("coalesces concurrent runs and schedules only after the active cycle settles", async () => {
    const inspection = deferred<"yes">();
    const scheduled: Array<() => void> = [];
    const monitorBackend = backend({
      inspectSession: vi.fn(() => inspection.promise),
    });
    const monitor = new DaemonSessionMonitor({
      sessionName: "alpha",
      backend: monitorBackend,
      setTimer: (callback) => {
        scheduled.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
    });

    const first = monitor.runOnce();
    const second = monitor.runOnce();
    expect(monitorBackend.inspectSession).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(0);

    inspection.resolve("yes");
    await Promise.all([first, second]);
    expect(scheduled).toHaveLength(1);
    await monitor.stop();
  });

  it("aborts and joins an active cycle without scheduling another tick", async () => {
    const scheduled: Array<() => void> = [];
    let observedSignal: AbortSignal | undefined;
    const monitorBackend = backend({
      inspectSession: vi.fn(
        async (_session, signal) =>
          await new Promise<"unknown">((resolve) => {
            observedSignal = signal;
            signal.addEventListener("abort", () => resolve("unknown"), { once: true });
          }),
      ),
    });
    const monitor = new DaemonSessionMonitor({
      sessionName: "alpha",
      backend: monitorBackend,
      setTimer: (callback) => {
        scheduled.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
    });

    const running = monitor.runOnce();
    await Promise.resolve();
    await monitor.stop();
    await running;

    expect(observedSignal?.aborted).toBe(true);
    expect(scheduled).toHaveLength(0);
  });

  it("issues pane credentials without UI clients and stops honestly when the session is gone", async () => {
    const reconcileCredentials = vi.fn(async () => undefined);
    const onSessionGone = vi.fn();
    const monitorBackend = backend({
      listCredentialSessions: () => ["alpha", "beta"],
      reconcileCredentials,
      hasClients: vi.fn(async () => false),
      onSessionGone,
    });
    const monitor = new DaemonSessionMonitor({ sessionName: "alpha", backend: monitorBackend });

    await monitor.runOnce();
    expect(reconcileCredentials.mock.calls.map(([session]) => session).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(monitorBackend.listPanes).not.toHaveBeenCalled();

    vi.mocked(monitorBackend.inspectSession).mockResolvedValueOnce("no");
    await monitor.runOnce();
    expect(onSessionGone).toHaveBeenCalledTimes(1);
    await monitor.stop();
  });

  it("projects changed pane state once and preserves title reconciliation", async () => {
    const setPaneOption = vi.fn(async () => undefined);
    const setPaneTitle = vi.fn(async () => undefined);
    const refreshClients = vi.fn(async () => undefined);
    const monitorBackend = backend({
      hasClients: vi.fn(async () => true),
      listPanes: vi.fn(async () => [
        {
          id: "%1",
          pid: "401",
          cmd: "claude",
          title: "shell-title",
          name: "Editor",
        },
      ]),
      readPortProcessFacts: vi.fn(async () => ({
        listeners: new Set(["401"]),
        tree: new Map(),
      })),
      setPaneOption,
      setPaneTitle,
      refreshClients,
    });
    const monitor = new DaemonSessionMonitor({ sessionName: "alpha", backend: monitorBackend });

    await monitor.runOnce();
    await monitor.runOnce();

    expect(setPaneOption.mock.calls).toEqual([
      ["%1", "@has_port", "1", expect.any(AbortSignal)],
      ["%1", "@agent_busy", "0", expect.any(AbortSignal)],
      ["%1", "@agent_idle", "1", expect.any(AbortSignal)],
    ]);
    expect(setPaneTitle).toHaveBeenCalledWith("%1", "Editor", expect.any(AbortSignal));
    expect(refreshClients).toHaveBeenCalledTimes(1);
    await monitor.stop();
  });

  it("retries the same pane state after a transient mutation failure", async () => {
    const setPaneOption = vi
      .fn<DaemonSessionMonitorBackend["setPaneOption"]>()
      .mockRejectedValueOnce(new Error("temporary tmux pipe failure"))
      .mockResolvedValue(undefined);
    const monitorBackend = backend({
      hasClients: vi.fn(async () => true),
      listPanes: vi.fn(async () => [{ id: "%1", pid: "401", cmd: "zsh" }]),
      readPortProcessFacts: vi.fn(async () => ({ listeners: new Set(), tree: new Map() })),
      setPaneOption,
    });
    const monitor = new DaemonSessionMonitor({ sessionName: "alpha", backend: monitorBackend });

    await monitor.runOnce();
    await monitor.runOnce();

    expect(setPaneOption).toHaveBeenCalledTimes(6);
    expect(monitorBackend.refreshClients).toHaveBeenCalledTimes(1);
    await monitor.stop();
  });

  it("classifies only confirmed tmux target disappearance as an idempotent no-op", () => {
    expect(isConfirmedMissingTmuxTarget(new Error("can't find pane: %9"))).toBe(true);
    expect(isConfirmedMissingTmuxTarget(new Error("no such session: gone"))).toBe(true);
    expect(isConfirmedMissingTmuxTarget(new Error("temporary tmux pipe failure"))).toBe(false);
  });

  it("keeps recurring tmux IO off synchronous child-process APIs", () => {
    const monitorSource = readFileSync(
      fileURLToPath(import.meta.url.replace(/\.test\.ts$/u, ".ts")),
      "utf8",
    );
    expect(monitorSource).not.toContain("execFileSync");
    expect(monitorSource).not.toContain("spawnSync");

    const daemonSource = readFileSync(
      fileURLToPath(new URL("./daemon-embed.ts", import.meta.url)),
      "utf8",
    );
    const recurringAdapter = daemonSource.slice(
      daemonSource.indexOf("const sessionMonitor ="),
      daemonSource.indexOf("sessionMonitor?.start();") + "sessionMonitor?.start();".length,
    );
    expect(recurringAdapter).not.toContain("tmuxSilent(");
    expect(recurringAdapter).not.toContain("execFileSync");
    expect(recurringAdapter).not.toContain("setInterval");
  });
});
