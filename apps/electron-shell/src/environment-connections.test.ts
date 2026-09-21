import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";
import { KnownEnvironmentCatalog } from "./environment-catalog.ts";
import {
  EnvironmentConnections,
  createSshEnvironmentAuthority,
} from "./environment-connections.ts";
import type { openSshDaemonTransport } from "../../../packages/daemon/src/lib/ssh-daemon-transport.ts";

type Transport = Awaited<ReturnType<typeof openSshDaemonTransport>>;
const instanceId = "9bcf33b0-c837-4a94-b5e8-c0977f54464f";
const environmentId = "7bcf33b0-c837-4a94-b5e8-c0977f54464f";
const identity = {
  instanceId,
  environmentId,
  protocolVersion: 1,
  productVersion: "2.9.0",
  startedAt: "2026-07-21T00:00:00.000Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function transport() {
  const closed = deferred<void>();
  return {
    daemon: {
      ...identity,
      pid: 123,
      port: 6060,
      bindHostname: "127.0.0.1",
      authToken: "private-secret",
    },
    baseUrl: "http://127.0.0.1:6161",
    closed: closed.promise,
    dispose: vi.fn(),
    close: () => closed.resolve(),
  } as Transport & { close(): void; dispose: ReturnType<typeof vi.fn> };
}
function authority() {
  return {
    state: vi.fn(() => ({ status: "connected", identity })),
    refreshConnection: vi.fn(async () => ({})),
    dispose: vi.fn(),
    releaseRenderer: vi.fn(),
  } as unknown as DaemonConnectionAuthority;
}
let directory: string;
let catalog: KnownEnvironmentCatalog;
const managers: EnvironmentConnections[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "environment-connections-"));
  catalog = new KnownEnvironmentCatalog(join(directory, "catalog.json"));
  await catalog.load();
});
afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.dispose());
  await catalog.flush();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function manager(options: Partial<ConstructorParameters<typeof EnvironmentConnections>[0]> = {}) {
  const result = new EnvironmentConnections({ catalog, localAuthority: authority(), ...options });
  managers.push(result);
  return result;
}

it("keeps aliases with identical daemon identities independent and snapshots credential-free", async () => {
  const a = await catalog.addSsh("one", "Same name");
  const b = await catalog.addSsh("two", "Same name");
  const first = transport();
  const second = transport();
  const local = authority();
  const connections = manager({
    localAuthority: local,
    openTransport: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    createRemoteAuthority: () => authority(),
  });
  await Promise.all([connections.connect(a.id), connections.connect(b.id)]);
  const captured = connections.capture(a.id)!;
  expect(captured.authority).not.toBe(connections.capture(b.id)!.authority);
  expect(JSON.stringify(connections.snapshots())).not.toMatch(
    /private-secret|127\.0\.0\.1|authToken|baseUrl/,
  );
  first.close();
  await Promise.resolve();
  expect(captured.isCurrent()).toBe(false);
  expect(connections.capture(b.id)?.isCurrent()).toBe(true);
  expect(connections.capture(catalog.localCanonical().id)?.isCurrent()).toBe(true);
  expect(local.dispose).not.toHaveBeenCalled();
});

it("deduplicates pending connects and bounds concurrent dials", async () => {
  const a = await catalog.addSsh("one");
  const b = await catalog.addSsh("two");
  const pending = deferred<Transport>();
  const open = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(transport());
  const connections = manager({
    dialLimit: 1,
    openTransport: open,
    createRemoteAuthority: () => authority(),
  });
  const first = connections.connect(a.id);
  expect(connections.connect(a.id)).toBe(first);
  const second = connections.connect(b.id);
  await Promise.resolve();
  expect(open).toHaveBeenCalledTimes(1);
  pending.resolve(transport());
  await Promise.all([first, second]);
  expect(open).toHaveBeenCalledTimes(2);
});

it("invalidates captures when a coordinator keeps its object but replaces environment identity", async () => {
  const entry = await catalog.addSsh("mini");
  const local = authority();
  const remote = authority();
  const connections = manager({
    localAuthority: local,
    openTransport: vi.fn().mockResolvedValue(transport()),
    createRemoteAuthority: () => remote,
  });
  const captured = await connections.connect(entry.id);
  const capturedLocal = connections.capture(catalog.localCanonical().id);
  expect(captured?.isCurrent()).toBe(true);
  vi.mocked(remote.state).mockReturnValue({
    status: "connected",
    identity: { ...identity, environmentId: "6bcf33b0-c837-4a94-b5e8-c0977f54464f" },
  });
  expect(captured?.isCurrent()).toBe(false);
  expect(capturedLocal?.isCurrent()).toBe(true);
  vi.mocked(local.state).mockReturnValue({
    status: "unavailable",
    code: "identity-unreachable",
    reason: "Unavailable",
  });
  expect(capturedLocal?.isCurrent()).toBe(false);
});

it("does not return replacement authority to a cancelled cold connect", async () => {
  const entry = await catalog.addSsh("mini");
  const oldDial = deferred<Transport>();
  const nextTransport = transport();
  const connections = manager({
    openTransport: vi
      .fn()
      .mockReturnValueOnce(oldDial.promise)
      .mockResolvedValueOnce(nextTransport),
    createRemoteAuthority: () => authority(),
  });
  const oldFlight = connections.connect(entry.id);
  connections.disconnect(entry.id);
  const newFlight = connections.connect(entry.id);
  expect(await oldFlight).toBeNull();
  expect((await newFlight)?.isCurrent()).toBe(true);
  const late = transport();
  oldDial.resolve(late);
  await Promise.resolve();
  await Promise.resolve();
  expect(late.dispose).toHaveBeenCalledOnce();
  expect(connections.capture(entry.id)?.isCurrent()).toBe(true);
});

it("disposes a transport arriving after cancellation without granting authority", async () => {
  const a = await catalog.addSsh("one");
  const pending = deferred<Transport>();
  const create = vi.fn(() => authority());
  const connections = manager({
    openTransport: vi.fn(() => pending.promise),
    createRemoteAuthority: create,
  });
  const flight = connections.connect(a.id);
  await Promise.resolve();
  connections.disconnect(a.id);
  await flight;
  const late = transport();
  pending.resolve(late);
  await new Promise((done) => setTimeout(done, 0));
  expect(late.dispose).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(connections.capture(a.id)).toBeNull();
});

it("does not let an old transport closure retire a replacement", async () => {
  const a = await catalog.addSsh("one");
  const first = transport();
  const second = transport();
  const connections = manager({
    openTransport: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    createRemoteAuthority: () => authority(),
  });
  await connections.connect(a.id);
  const old = connections.capture(a.id)!;
  connections.disconnect(a.id);
  await connections.connect(a.id);
  first.close();
  await Promise.resolve();
  expect(old.isCurrent()).toBe(false);
  expect(connections.capture(a.id)?.isCurrent()).toBe(true);
  expect(second.dispose).not.toHaveBeenCalled();
});

it("continues teardown after an authority throws and never disposes borrowed local authority", async () => {
  const a = await catalog.addSsh("one");
  const b = await catalog.addSsh("two");
  const first = transport();
  const second = transport();
  const local = authority();
  const broken = authority();
  vi.mocked(broken.dispose).mockImplementation(() => {
    throw Error("cleanup");
  });
  const connections = manager({
    localAuthority: local,
    openTransport: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    createRemoteAuthority: vi.fn().mockReturnValueOnce(broken).mockReturnValueOnce(authority()),
  });
  await Promise.all([connections.connect(a.id), connections.connect(b.id)]);
  const captured = connections.capture(b.id)!;
  connections.dispose();
  expect(captured.isCurrent()).toBe(false);
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(second.dispose).toHaveBeenCalledOnce();
  expect(local.dispose).not.toHaveBeenCalled();
});

it("expires queued work without opening another transport", async () => {
  const a = await catalog.addSsh("one");
  const b = await catalog.addSsh("two");
  const pending = deferred<Transport>();
  const open = vi.fn(() => pending.promise);
  const connections = manager({ timeoutMs: 10, dialLimit: 1, openTransport: open });
  await Promise.all([connections.connect(a.id), connections.connect(b.id)]);
  expect(open).toHaveBeenCalledTimes(1);
  expect(
    connections
      .snapshots()
      .filter((item) => item.kind === "ssh")
      .every((item) => item.phase === "needs-attention"),
  ).toBe(true);
  const late = transport();
  pending.resolve(late);
  await new Promise((done) => setTimeout(done, 0));
  expect(late.dispose).toHaveBeenCalledOnce();
});

it("constructs real remote authority from its handshake without local daemon discovery", async () => {
  const remote = transport();
  const coordinator = createSshEnvironmentAuthority(remote);
  try {
    expect(coordinator.state()).toMatchObject({ status: "connected", identity });
    expect(JSON.stringify(coordinator.state())).not.toContain("private-secret");
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 503 }));
    await coordinator.refreshConnection();
    expect(request).toHaveBeenCalledWith(
      `${remote.baseUrl}/identity`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(JSON.stringify(request.mock.calls)).not.toContain("private-secret");
  } finally {
    coordinator.dispose();
  }
});
