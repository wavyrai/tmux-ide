import { expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";
import type { EnvironmentAuthorityCapture } from "./environment-connections.ts";
import type { HostIpcDependencies } from "./host-ipc.ts";
const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("./host-ipc.ts", () => ({ registerHostIpc: register }));
import { EnvironmentHostIpc } from "./environment-host-ipc.ts";
const ID = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const live = new Map<string, unknown>([["local", {}]]);
  const registrations: Array<{
    dispose: ReturnType<typeof vi.fn>;
    bindWindow: ReturnType<typeof vi.fn>;
    releaseRenderer: ReturnType<typeof vi.fn>;
  }> = [];
  register.mockImplementation((deps: HostIpcDependencies) => {
    const scope = deps.channelScope!;
    live.set(scope, deps.daemonResources);
    const registration = {
      dispose: vi.fn(() => live.delete(scope)),
      bindWindow: vi.fn(),
      releaseRenderer: vi.fn(),
    };
    registrations.push(registration);
    return registration;
  });
  let listener = () => {};
  const unsubscribe = vi.fn();
  let current: EnvironmentAuthorityCapture | null = null;
  const connect = vi.fn(async (): Promise<EnvironmentAuthorityCapture | null> => current);
  const connections = {
    snapshots: () => [
      {
        connectionId: ID,
        label: "Remote",
        kind: "ssh" as const,
        phase: "ready" as const,
        daemon: null,
        failure: null,
      },
      {
        connectionId: "local",
        label: "Local",
        kind: "local-canonical" as const,
        phase: "ready" as const,
        daemon: null,
        failure: null,
      },
    ],
    connect,
    capture: () => current,
    subscribe: (callback: () => void) => {
      listener = callback;
      return unsubscribe;
    },
  };
  const setAuthority = () => {
    let valid = true;
    const identity = {
      protocolVersion: 1,
      productVersion: "test",
      instanceId: ID,
      startedAt: "2026-07-21T00:00:00.000Z",
    };
    const authority = {
      state: () => ({ status: "connected", identity }),
    } as unknown as DaemonConnectionAuthority;
    current = { connectionId: ID, authority, isCurrent: () => valid };
    return {
      retire: () => {
        valid = false;
        current = null;
        listener();
      },
      identity,
    };
  };
  const owner = new EnvironmentHostIpc({
    connections,
    host: { getWindow: () => null } as Omit<
      HostIpcDependencies,
      "daemonResources" | "channelScope"
    >,
  });
  return {
    owner,
    live,
    registrations,
    connect,
    setAuthority,
    unsubscribe,
    publish: () => listener(),
  };
}
it("reuses only a current binding, retires handlers, and never reuses reconnect scope", async () => {
  const t = fixture();
  const first = t.setAuthority();
  const a = await t.owner.open(ID);
  expect(await t.owner.open(ID)).toEqual(a);
  first.retire();
  expect(t.live.has(a.scope)).toBe(false);
  expect(t.live.has("local")).toBe(true);
  t.setAuthority();
  const b = await t.owner.open(ID);
  expect(b.scope).not.toBe(a.scope);
  const window = {} as BrowserWindow;
  t.owner.bindWindow(window);
  expect(t.registrations[1]!.bindWindow).toHaveBeenCalledWith(window);
  t.owner.releaseRenderer();
  expect(t.registrations[1]!.releaseRenderer).toHaveBeenCalledOnce();
  t.owner.dispose();
  expect([...t.live.keys()]).toEqual(["local"]);
  expect(t.unsubscribe).toHaveBeenCalledOnce();
  await expect(t.owner.open(ID)).rejects.toThrow("disposed");
});
it("rejects retirement while awaiting connection and disposal while open", async () => {
  const t = fixture();
  const first = t.setAuthority();
  let finish!: (value: EnvironmentAuthorityCapture | null) => void;
  t.connect.mockImplementationOnce(
    () =>
      new Promise<EnvironmentAuthorityCapture | null>((resolve) => {
        finish = resolve;
      }),
  );
  const opening = t.owner.open(ID);
  first.retire();
  finish(null);
  await expect(opening).rejects.toThrow("retired");
  t.connect.mockImplementationOnce(
    () =>
      new Promise<EnvironmentAuthorityCapture | null>((resolve) => {
        finish = resolve;
      }),
  );
  const next = t.owner.open(ID);
  t.owner.dispose();
  finish(null);
  await expect(next).rejects.toThrow("disposed");
  expect([...t.live.keys()]).toEqual(["local"]);
});
it("does not adopt a replacement connection after an older dial completes", async () => {
  const t = fixture();
  t.setAuthority();
  let finish!: (value: EnvironmentAuthorityCapture | null) => void;
  t.connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const oldOpen = t.owner.open(ID);
  t.setAuthority();
  const replacement = await t.owner.open(ID);
  // The manager returns null for the exact retired attempt, even though a new
  // capture is now available for the same catalog connection id.
  finish(null);
  await expect(oldOpen).rejects.toThrow("retired");
  expect(t.live.has(replacement.scope)).toBe(true);
  expect(t.registrations).toHaveLength(1);
  t.owner.dispose();
});
it("retires same-coordinator daemon identity changes", async () => {
  const t = fixture();
  const first = t.setAuthority();
  const a = await t.owner.open(ID);
  first.identity.instanceId = "00000000-0000-4000-8000-000000000002";
  t.publish();
  expect(t.live.has(a.scope)).toBe(false);
  const b = await t.owner.open(ID);
  expect(b.scope).not.toBe(a.scope);
  t.owner.dispose();
});

it("rejects local alias without creating a second owner or releasing local resources", async () => {
  const t = fixture();
  await expect(t.owner.open("local")).rejects.toThrow("local host alias");
  expect(t.connect).not.toHaveBeenCalled();
  expect(t.registrations).toHaveLength(0);
  t.owner.dispose();
  expect(t.live.has("local")).toBe(true);
});
