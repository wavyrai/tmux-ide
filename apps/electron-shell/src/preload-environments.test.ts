import { describe, expect, it, vi } from "vitest";
import { createPreloadEnvironments } from "./preload-environments.ts";
import { type PreloadDaemonIpc } from "./preload-daemon.ts";
import { HOST_IPC, scopedHostChannel } from "./ipc-channels.ts";

const id = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000001";
const scope = "30000000-0000-4000-8000-000000000001";
const newer = "40000000-0000-4000-8000-000000000001";
function rig() {
  const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
  const invoke = vi.fn<PreloadDaemonIpc["invoke"]>().mockResolvedValue({ connectionId: id, scope });
  const ipc: PreloadDaemonIpc = {
    invoke,
    on(channel, fn) {
      const group = listeners.get(channel) ?? new Set();
      group.add(fn);
      listeners.set(channel, group);
    },
    removeListener(channel, fn) {
      listeners.get(channel)?.delete(fn);
    },
  };
  return { invoke, listeners, ...createPreloadEnvironments(ipc) };
}

describe("public environment preload facade", () => {
  it("reuses maps for the same scope and never exposes its scope or connection descriptor", async () => {
    const r = rig();
    const [first, second] = await Promise.all([r.environments.open(id), r.environments.open(id)]);
    expect(first).toBe(second);
    expect(Object.keys(first).sort()).toEqual(["bootstrap", "daemon", "dispose"]);
    expect(r.listeners.get(scopedHostChannel(scope, HOST_IPC.daemonEvent))?.size).toBe(1);
    r.invoke.mockResolvedValueOnce({ invalid: true });
    await expect(first.bootstrap()).rejects.toThrow();
    expect(r.invoke.mock.lastCall).toEqual([scopedHostChannel(scope, HOST_IPC.bootstrap)]);
    r.dispose();
  });

  it("retires a replaced scope and preserves an independent connection", async () => {
    const r = rig();
    const first = await r.environments.open(id);
    r.invoke.mockResolvedValueOnce({ connectionId: other, scope: newer });
    const independent = await r.environments.open(other);
    r.invoke.mockResolvedValueOnce({
      connectionId: id,
      scope: "50000000-0000-4000-8000-000000000001",
    });
    const replacement = await r.environments.open(id);
    expect(replacement).not.toBe(first);
    await expect(first.bootstrap()).rejects.toThrow("disposed");
    expect(r.listeners.get(scopedHostChannel(newer, HOST_IPC.daemonEvent))?.size).toBe(1);
    independent.dispose();
    expect(r.listeners.get(scopedHostChannel(newer, HOST_IPC.daemonEvent))?.size).toBe(0);
    r.dispose();
  });

  it("explicit disconnect disposes only that connection and fences a pending open", async () => {
    const r = rig();
    const first = await r.environments.open(id);
    let settle!: (value: unknown) => void;
    r.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const pending = r.environments.open(id);
    r.invoke.mockResolvedValueOnce(undefined);
    await r.environments.disconnect(id);
    settle({ connectionId: id, scope: newer });
    await expect(pending).rejects.toThrow("superseded");
    await expect(first.bootstrap()).rejects.toThrow("disposed");
    expect(r.listeners.get(scopedHostChannel(scope, HOST_IPC.daemonEvent))?.size).toBe(0);
    r.dispose();
  });

  it("does not let a late older open retire a newer authority scope", async () => {
    const r = rig();
    let settle!: (value: unknown) => void;
    r.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const old = r.environments.open(id);
    r.invoke.mockResolvedValueOnce({ connectionId: id, scope: newer });
    await r.environments.open(id);
    settle({ connectionId: id, scope });
    await expect(old).rejects.toThrow("superseded");
    expect(r.listeners.get(scopedHostChannel(newer, HOST_IPC.daemonEvent))?.size).toBe(1);
    r.dispose();
  });

  it("validates input, list and open replies, and refuses cross-connection scope reuse", async () => {
    const r = rig();
    await expect(r.environments.open("ssh://host")).rejects.toThrow();
    expect(r.invoke).not.toHaveBeenCalled();
    r.invoke.mockResolvedValueOnce([
      {
        connectionId: id,
        label: "Build",
        kind: "ssh",
        phase: "disconnected",
        daemon: null,
        failure: null,
      },
    ]);
    await expect(r.environments.list()).resolves.toHaveLength(1);
    r.invoke.mockResolvedValueOnce([
      {
        connectionId: id,
        label: "Build",
        kind: "ssh",
        phase: "needs-attention",
        daemon: null,
        failure: "identity-mismatch",
      },
    ]);
    await expect(r.environments.list()).resolves.toEqual([
      expect.objectContaining({ failure: "identity-mismatch" }),
    ]);
    r.invoke.mockResolvedValueOnce([
      {
        connectionId: id,
        label: "Build",
        kind: "ssh",
        phase: "disconnected",
        daemon: null,
        failure: null,
        authToken: "secret",
      },
    ]);
    await expect(r.environments.list()).rejects.toThrow();
    r.invoke.mockResolvedValueOnce({ connectionId: other, scope });
    await expect(r.environments.open(id)).rejects.toThrow("identity mismatch");
    await r.environments.open(id);
    r.invoke.mockResolvedValueOnce({ connectionId: other, scope });
    await expect(r.environments.open(other)).rejects.toThrow("scope identity mismatch");
    r.dispose();
  });

  it("drops all listeners and cached scopes at renderer teardown without calling disconnect", async () => {
    const r = rig();
    await r.environments.open(id);
    const listener = vi.fn();
    const off = r.environments.onChanged(listener);
    for (const receive of r.listeners.get(HOST_IPC.environmentChanged) ?? [])
      receive({}, { ignored: "payload" });
    expect(listener).toHaveBeenCalledWith();
    off();
    r.dispose();
    r.dispose();
    expect([...r.listeners.values()].every((group) => group.size === 0)).toBe(true);
    expect(
      r.invoke.mock.calls.some(([channel]) => channel === HOST_IPC.environmentDisconnect),
    ).toBe(false);
    await expect(r.environments.list()).rejects.toThrow("disposed");
  });
});
