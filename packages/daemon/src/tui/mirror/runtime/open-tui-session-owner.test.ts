import { describe, expect, it, vi } from "vitest";
import type {
  OpenTuiGenerationHost,
  OpenTuiGenerationHostSnapshot,
} from "./open-tui-generation-host.ts";
import { createOpenTuiSessionOwner } from "./open-tui-session-owner.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function snapshot(sessionName: string, status: "connecting" | "live" | "unavailable") {
  return {
    status,
    rendererEpoch: status === "live" ? 1 : 0,
    daemonGeneration: status === "live" ? `generation-${sessionName}` : null,
    connection: null,
    client: null,
    fastLane: null,
    adapter: null,
  } as OpenTuiGenerationHostSnapshot;
}

class FakeHost implements OpenTuiGenerationHost {
  readonly startGate = deferred<boolean>();
  readonly listeners = new Set<(value: OpenTuiGenerationHostSnapshot) => void>();
  readonly dispose = vi.fn(async () => undefined);
  current: OpenTuiGenerationHostSnapshot;
  constructor(readonly sessionName: string) {
    this.current = snapshot(sessionName, "connecting");
  }
  getSnapshot(): OpenTuiGenerationHostSnapshot {
    return this.current;
  }
  subscribe(listener: (value: OpenTuiGenerationHostSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
  start(): Promise<boolean> {
    return this.startGate.promise;
  }
  finish(started: boolean): void {
    this.current = snapshot(this.sessionName, started ? "live" : "unavailable");
    for (const listener of this.listeners) listener(this.current);
    this.startGate.resolve(started);
  }
  emit(value: OpenTuiGenerationHostSnapshot): void {
    this.current = value;
    for (const listener of this.listeners) listener(value);
  }
}

describe("OpenTUI session owner", () => {
  it("fully resets a failed host so the same session can retry", async () => {
    const hosts: FakeHost[] = [];
    const owner = createOpenTuiSessionOwner({
      ensureWorkspace: vi.fn(async () => true),
      createHost: (sessionName) => {
        const host = new FakeHost(sessionName);
        hosts.push(host);
        return host;
      },
      onSnapshot: vi.fn(),
    });
    const first = owner.open("alpha");
    await flush();
    hosts[0]!.finish(false);
    expect(await first).toBe(false);
    expect(hosts[0]!.dispose).toHaveBeenCalledOnce();
    expect(owner.sessionName()).toBeNull();

    const retry = owner.open("alpha");
    await flush();
    hosts[1]!.finish(true);
    expect(await retry).toBe(true);
    expect(owner.sessionName()).toBe("alpha");
    await owner.dispose();
  });

  it("retains A until B is live, then awaits A retirement", async () => {
    const hosts = new Map<string, FakeHost>();
    const published: Array<string | null> = [];
    const owner = createOpenTuiSessionOwner({
      ensureWorkspace: vi.fn(async () => true),
      createHost: (sessionName) => {
        const host = new FakeHost(sessionName);
        hosts.set(sessionName, host);
        return host;
      },
      onSnapshot: (value) => published.push(value?.daemonGeneration ?? null),
    });
    const first = owner.open("alpha");
    await flush();
    hosts.get("alpha")!.finish(true);
    await first;
    const switchFlight = owner.open("beta");
    await flush();
    expect(owner.sessionName()).toBe("alpha");
    expect(owner.snapshot()?.daemonGeneration).toBe("generation-alpha");
    expect(hosts.get("alpha")!.dispose).not.toHaveBeenCalled();

    hosts.get("beta")!.finish(true);
    expect(await switchFlight).toBe(true);
    expect(owner.sessionName()).toBe("beta");
    expect(hosts.get("alpha")!.dispose).toHaveBeenCalledOnce();
    expect(published.at(-1)).toBe("generation-beta");
    await owner.dispose();
  });

  it("forwards every post-activation snapshot from the active host", async () => {
    let host!: FakeHost;
    const published: OpenTuiGenerationHostSnapshot[] = [];
    const owner = createOpenTuiSessionOwner({
      ensureWorkspace: vi.fn(async () => true),
      createHost: (sessionName) => (host = new FakeHost(sessionName)),
      onSnapshot: (value) => {
        if (value) published.push(value);
      },
    });
    const opening = owner.open("alpha");
    await flush();
    host.finish(true);
    await opening;
    host.emit({ ...snapshot("alpha", "live"), rendererEpoch: 2 });
    expect(published.at(-1)?.rendererEpoch).toBe(2);
    expect(owner.snapshot()?.rendererEpoch).toBe(2);
    await owner.dispose();
  });

  it("fences retired-host snapshots after a target replacement", async () => {
    const hosts = new Map<string, FakeHost>();
    const published: OpenTuiGenerationHostSnapshot[] = [];
    const owner = createOpenTuiSessionOwner({
      ensureWorkspace: vi.fn(async () => true),
      createHost: (sessionName) => {
        const host = new FakeHost(sessionName);
        hosts.set(sessionName, host);
        return host;
      },
      onSnapshot: (value) => {
        if (value) published.push(value);
      },
    });
    const alpha = owner.open("alpha");
    await flush();
    hosts.get("alpha")!.finish(true);
    await alpha;
    const beta = owner.open("beta");
    await flush();
    hosts.get("beta")!.finish(true);
    await beta;

    const countAfterReplacement = published.length;
    hosts.get("alpha")!.emit({ ...snapshot("alpha", "live"), rendererEpoch: 9 });
    expect(published).toHaveLength(countAfterReplacement);
    hosts.get("beta")!.emit({ ...snapshot("beta", "live"), rendererEpoch: 3 });
    expect(published.at(-1)).toMatchObject({
      rendererEpoch: 3,
      daemonGeneration: "generation-beta",
    });
    await owner.dispose();
  });

  it("interrupts an in-flight first open during disposal", async () => {
    let host!: FakeHost;
    const owner = createOpenTuiSessionOwner({
      ensureWorkspace: vi.fn(async () => true),
      createHost: (sessionName) => (host = new FakeHost(sessionName)),
      onSnapshot: vi.fn(),
    });
    const opening = owner.open("alpha");
    await flush();
    const disposal = owner.dispose();
    expect(host.dispose).toHaveBeenCalledOnce();
    host.finish(false);
    await expect(opening).resolves.toBe(false);
    await disposal;
  });
});
