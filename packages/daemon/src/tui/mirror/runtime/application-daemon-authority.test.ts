import { SshConnectionError } from "../../../lib/ssh-daemon-transport.ts";
import { describe, expect, it, vi } from "vitest";
import {
  createApplicationDaemonAuthority,
  type ApplicationDaemonAuthorityDependencies,
} from "./application-daemon-authority.ts";
const remote = {
  pid: 999999,
  port: 7000,
  protocolVersion: 2,
  productVersion: "beta",
  instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  startedAt: "2026-09-09T10:00:00.000Z",
  bindHostname: "127.0.0.1" as const,
  authToken: "ephemeral-secret",
};
function connection(port: number) {
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    daemon: remote,
    baseUrl: `http://127.0.0.1:${port}`,
    closed,
    dispose: vi.fn(close),
    close,
  };
}
function setup() {
  const first = connection(43210),
    second = connection(43211);
  const deps: ApplicationDaemonAuthorityDependencies = {
    readLocal: vi.fn(() => ({ ...remote, pid: process.pid })),
    isLocalAlive: vi.fn(async () => true),
    observeLocal: vi.fn(async () => () => {}),
    connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    retryDelayMs: 1,
  };
  return { first, second, deps, authority: createApplicationDaemonAuthority(deps) };
}
describe("selected application machine authority", () => {
  it("keeps local reads and observation delegated until SSH is selected", async () => {
    const f = setup();
    expect(f.authority.read()?.pid).toBe(process.pid);
    expect(await f.authority.isAlive(remote)).toBe(true);
    const stop = await f.authority.observe(() => {});
    stop();
    expect(f.deps.observeLocal).toHaveBeenCalledOnce();
  });
  it("pins original remote identity and routes through a separate loopback endpoint", async () => {
    const f = setup();
    await f.authority.initialize("build");
    expect(f.authority.read()).toEqual({ ...remote, port: 43210 });
    expect(f.authority.endpoint()).toMatchObject({
      kind: "ssh",
      label: "build",
      remote,
      localBaseUrl: "http://127.0.0.1:43210",
      state: "ready",
    });
    expect(Object.isFrozen(f.authority.read())).toBe(true);
    expect(await f.authority.isAlive({ ...remote, port: 43210 })).toBe(true);
    expect(f.deps.readLocal).not.toHaveBeenCalled();
    expect(f.deps.isLocalAlive).not.toHaveBeenCalled();
    f.authority.dispose();
  });
  it("retires immediately then reconnects even to the same daemon with a new tunnel", async () => {
    const f = setup();
    await f.authority.initialize("build");
    const events: Array<string | null> = [];
    await f.authority.observe((value) => events.push(value));
    const epoch = f.authority.endpoint().epoch;
    f.first.close();
    await Promise.resolve();
    expect(f.authority.read()).toBeNull();
    expect(events).toEqual([null]);
    expect(f.authority.endpoint().label).toBe("build");
    await vi.waitFor(() => expect(f.authority.read()?.port).toBe(43211), {
      interval: 1,
      timeout: 100,
    });
    expect(events).toEqual([null, remote.instanceId]);
    expect(f.authority.endpoint().epoch).toBeGreaterThan(epoch);
    expect(await f.authority.isAlive({ ...remote, port: 43210 })).toBe(false);
    expect(f.deps.readLocal).not.toHaveBeenCalled();
    f.authority.dispose();
  });
  it("retries temporary reopen failures without exposing local authority", async () => {
    const f = setup();
    f.deps.connect = vi
      .fn()
      .mockResolvedValueOnce(f.first)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(f.second);
    await f.authority.initialize("build");
    f.first.close();
    await vi.waitFor(() => expect(f.authority.read()?.port).toBe(43211), {
      interval: 1,
      timeout: 1000,
    });
    expect(f.deps.connect).toHaveBeenCalledTimes(3);
    expect(f.deps.readLocal).not.toHaveBeenCalled();
    f.authority.dispose();
    const epoch = f.authority.endpoint().epoch;
    f.authority.dispose();
    expect(f.authority.endpoint().epoch).toBe(epoch);
  });
  it("rediscovers a restarted daemon even while its SSH process remains alive", async () => {
    const f = setup();
    f.deps.probeIntervalMs = 1;
    f.deps.probeTimeoutMs = 20;
    f.deps.verify = vi.fn(async (baseUrl) => baseUrl === f.second.baseUrl);
    await f.authority.initialize("build");
    await vi.waitFor(() => expect(f.authority.read()?.port).toBe(43211), {
      interval: 1,
      timeout: 1000,
    });
    expect(f.first.dispose).toHaveBeenCalledOnce();
    expect(f.deps.verify).toHaveBeenCalledTimes(2);
    expect(f.deps.connect).toHaveBeenCalledTimes(2);
    f.authority.dispose();
  });
  it("allows one transient probe failure without retiring the current connection", async () => {
    const f = setup();
    f.deps.probeIntervalMs = 1;
    f.deps.verify = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await f.authority.initialize("build");
    await vi.waitFor(() => expect(f.deps.verify).toHaveBeenCalledTimes(2), {
      interval: 1,
      timeout: 1000,
    });
    expect(f.authority.read()?.port).toBe(43210);
    expect(f.first.dispose).not.toHaveBeenCalled();
    f.authority.dispose();
  });
  it("never overlaps a pending probe and aborts it plus its timer on disposal", async () => {
    const f = setup();
    f.deps.probeIntervalMs = 1;
    f.deps.probeTimeoutMs = 100;
    let captured: AbortSignal | null = null;
    f.deps.verify = vi.fn(
      (_url, _daemon, signal) =>
        new Promise<boolean>((resolve) => {
          captured = signal;
          signal.addEventListener("abort", () => resolve(false), { once: true });
        }),
    );
    await f.authority.initialize("build");
    await vi.waitFor(() => expect(f.deps.verify).toHaveBeenCalledOnce(), {
      interval: 1,
      timeout: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.deps.verify).toHaveBeenCalledOnce();
    f.authority.dispose();
    expect((captured as AbortSignal | null)?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.deps.verify).toHaveBeenCalledOnce();
    expect(f.deps.connect).toHaveBeenCalledOnce();
  });
  it("bounds each stalled network probe by aborting its request", async () => {
    const f = setup();
    f.deps.probeIntervalMs = 1;
    f.deps.probeTimeoutMs = 2;
    const aborted: boolean[] = [];
    f.deps.verify = vi.fn(
      (_url, _daemon, signal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.push(signal.aborted);
              resolve(false);
            },
            { once: true },
          );
        }),
    );
    await f.authority.initialize("build");
    await vi.waitFor(() => expect(f.deps.connect).toHaveBeenCalledTimes(2), {
      interval: 1,
      timeout: 1000,
    });
    expect(aborted).toEqual([true, true]);
    f.authority.dispose();
  });
  it("disposal cancels reconnect and never falls back to local data", async () => {
    const f = setup();
    await f.authority.initialize("build");
    f.first.close();
    await Promise.resolve();
    f.authority.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.deps.connect).toHaveBeenCalledTimes(1);
    expect(f.authority.read()).toBeNull();
    expect(await f.authority.isAlive(remote)).toBe(false);
    expect(f.deps.readLocal).not.toHaveBeenCalled();
  });
  it("cancels a late initial connection and keeps the selected remote unavailable", async () => {
    const f = setup();
    let resolve!: (value: typeof f.first) => void;
    f.deps.connect = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const abort = new AbortController();
    const started = f.authority.initialize("build", abort.signal);
    abort.abort();
    resolve(f.first);
    await expect(started).rejects.toThrow("cancelled");
    expect(f.first.dispose).toHaveBeenCalled();
    expect(f.authority.read()).toBeNull();
  });
  it("failed initial authentication does not expose local sessions", async () => {
    const f = setup();
    f.deps.connect = vi.fn().mockRejectedValue(new Error("unavailable"));
    await expect(f.authority.initialize("build")).rejects.toThrow("unavailable");
    expect(f.authority.endpoint().kind).toBe("ssh");
    expect(f.authority.read()).toBeNull();
    expect(f.deps.readLocal).not.toHaveBeenCalled();
    f.authority.dispose();
  });
});

describe("machine connection controls", () => {
  it("pauses permanent failure and explicitly retries without changing authority owner", async () => {
    const f = setup();
    f.deps.connect = vi
      .fn()
      .mockRejectedValueOnce(new SshConnectionError("bad protocol", "incompatible"))
      .mockResolvedValueOnce(f.second);
    const updates = vi.fn();
    const stop = f.authority.observeConnection(updates);
    await expect(f.authority.initialize("build")).rejects.toThrow("bad protocol");
    await new Promise((done) => setTimeout(done, 5));
    expect(f.deps.connect).toHaveBeenCalledTimes(1);
    expect(f.authority.endpoint().diagnostic).toMatchObject({
      phase: "needs-attention",
      failure: "incompatible",
      nextRetryAt: null,
    });
    await f.authority.retry();
    await vi.waitFor(() => expect(f.authority.read()?.port).toBe(43211));
    expect(updates).toHaveBeenCalled();
    stop();
    f.authority.dispose();
  });
  it("disconnect retires immediately, cancels retries, and can reconnect on demand", async () => {
    const f = setup();
    await f.authority.initialize("build");
    f.authority.disconnect();
    expect(f.authority.read()).toBeNull();
    expect(f.first.dispose).toHaveBeenCalledOnce();
    expect(f.authority.endpoint().diagnostic?.phase).toBe("disconnected");
    await new Promise((done) => setTimeout(done, 5));
    expect(f.deps.connect).toHaveBeenCalledTimes(1);
    await Promise.all([f.authority.retry(), f.authority.retry()]);
    await vi.waitFor(() => expect(f.authority.read()?.port).toBe(43211));
    expect(f.deps.connect).toHaveBeenCalledTimes(2);
    f.authority.dispose();
  });
  it("exposes a retry deadline but never publishes arbitrary transport error text", async () => {
    const f = setup();
    f.deps.retryDelayMs = 10000;
    f.deps.connect = vi.fn().mockRejectedValue(new Error("secret-credential"));
    await expect(f.authority.initialize("build")).rejects.toThrow();
    await Promise.resolve();
    const status = f.authority.endpoint().diagnostic!;
    expect(status.phase).toBe("reconnecting");
    expect(status.nextRetryAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(status)).not.toContain("secret-credential");
    f.authority.dispose();
  });
});
