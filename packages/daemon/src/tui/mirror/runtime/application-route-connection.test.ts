import { expect, it, vi } from "vitest";
import type { ApplicationMachineAuthorityHandle } from "./application-machine-authority.ts";
const f = vi.hoisted(() => ({
  prepare: vi.fn(),
  ensure: vi.fn(),
  servers: vi.fn(),
  sessions: vi.fn(),
  clientDispose: vi.fn(),
}));
vi.mock("@tmux-ide/daemon-client/tmux-server-client", () => ({
  listTmuxServers: f.servers,
  createTmuxServerClient: () => ({ sessions: f.sessions, dispose: f.clientDispose }),
}));
vi.mock("../application-shell-daemon-connection.ts", () => ({
  prepareOpenTuiApplicationShellConnection: f.prepare,
}));
vi.mock("../configless-session-bootstrap.ts", () => ({
  ensureOpenTuiSessionWorkspaceResult: f.ensure,
}));
import { applicationRouteConnection } from "./application-route-connection.ts";
it("pins reads, promotion and observation to the tab's route and rejects a replacement incarnation", async () => {
  const handle = {
    read: vi.fn(),
    isAlive: vi.fn(),
    observe: vi.fn(),
  } as unknown as ApplicationMachineAuthorityHandle;
  const dispose = vi.fn();
  f.prepare.mockResolvedValue({ liveSessionId: "replacement", dispose });
  const route = applicationRouteConnection(handle, "original");
  expect(route.readDaemon).toBe(handle.read);
  expect(route.observeCanonicalGeneration).toBe(handle.observe);
  expect(await route.resolveConnection("same-name")).toBeNull();
  expect(dispose).toHaveBeenCalledOnce();
  const deps = f.prepare.mock.calls[0][1];
  expect(deps.readCanonicalDaemonInfo).toBe(handle.read);
  expect(deps.isCanonicalDaemonAlive).toBe(handle.isAlive);
});
it("keeps typed promotion outcome through the machine-route adapter", async () => {
  const failure = {
    status: "unavailable",
    reason: "promotion-rejected",
    code: "operation_capacity",
    operationId: "op-1",
  };
  f.ensure.mockResolvedValue(failure);
  f.prepare.mockImplementation(async (_session, dependencies) =>
    dependencies.ensureSessionWorkspace("alpha"),
  );
  const handle = {
    read: vi.fn(),
    isAlive: vi.fn(),
    observe: vi.fn(),
  } as unknown as ApplicationMachineAuthorityHandle;
  expect(await applicationRouteConnection(handle).resolveConnection("alpha")).toBe(failure);
});
it("retains server and live identity, and retires when its root daemon is replaced", async () => {
  let listener!: (generation: string | null) => void;
  const handle = {
    read: () => ({ instanceId: "root-one" }),
    endpoint: vi.fn(),
    isAlive: vi.fn(),
    observe: vi.fn(async (value) => {
      listener = value;
      return () => {};
    }),
  } as unknown as ApplicationMachineAuthorityHandle;
  const server = {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "11111111-1111-4111-8111-111111111111",
  };
  const route = applicationRouteConnection(handle, "live-session.one", undefined, server);
  const observed = vi.fn();
  await route.observeCanonicalGeneration(observed);
  listener("root-one");
  expect(observed).toHaveBeenLastCalledWith(server.generation);
  listener("root-two");
  expect(observed).toHaveBeenLastCalledWith(null);
  f.prepare.mockResolvedValue({ liveSessionId: "live-session.one", dispose: vi.fn() });
  await route.resolveConnection("same");
  expect(f.prepare).toHaveBeenLastCalledWith(
    "same",
    expect.objectContaining({
      server,
      expectedLiveSessionId: "live-session.one",
      readDaemonEndpoint: handle.endpoint,
    }),
  );
});

function reconnectFixture() {
  let root = "root-one";
  let epoch = 1;
  let listener!: (value: string | null) => void;
  const handle = {
    read: () => ({ instanceId: root, authToken: "owner", bindHostname: "127.0.0.1", port: 12345 }),
    endpoint: () => ({ epoch }),
    isAlive: vi.fn(),
    observe: async (next: typeof listener) => {
      listener = next;
      return () => {};
    },
  } as unknown as ApplicationMachineAuthorityHandle;
  const server = {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "11111111-1111-4111-8111-111111111111",
  };
  const next = { ...server, generation: "22222222-2222-4222-8222-222222222222" };
  const route = applicationRouteConnection(handle, "live-session.one", undefined, server);
  f.servers
    .mockReset()
    .mockResolvedValue({ version: 1, servers: [{ ...next, state: "online", label: "Work" }] });
  f.sessions.mockReset().mockResolvedValue({
    version: 1,
    server: next,
    sessions: [{ sessionName: "same", liveSessionId: "live-session.one" }],
  });
  f.prepare.mockReset().mockResolvedValue({ liveSessionId: "live-session.one", dispose: vi.fn() });
  return {
    route,
    server,
    next,
    emit: (value: string | null) => listener(value),
    replace: (value = "root-two") => {
      root = value;
      epoch++;
    },
    handle,
  };
}
it("requalifies the same registered native session after daemon restart before publishing new authority", async () => {
  const x = reconnectFixture(),
    observed = vi.fn();
  await x.route.observeCanonicalGeneration(observed);
  x.emit("root-one");
  x.replace();
  x.emit("root-two");
  expect(observed).toHaveBeenLastCalledWith(null);
  await vi.waitFor(() => expect(observed).toHaveBeenLastCalledWith(x.next.generation));
  await x.route.resolveConnection("same");
  expect(f.prepare).toHaveBeenLastCalledWith(
    "same",
    expect.objectContaining({ server: x.next, expectedLiveSessionId: "live-session.one" }),
  );
});
it.each(["missing", "offline", "replacement"])(
  "refuses %s selected native authority after daemon restart",
  async (reason) => {
    const x = reconnectFixture(),
      observed = vi.fn();
    if (reason === "missing") f.servers.mockResolvedValue({ version: 1, servers: [] });
    if (reason === "offline")
      f.servers.mockResolvedValue({
        version: 1,
        servers: [{ ...x.next, state: "offline", generation: null, label: "Work" }],
      });
    if (reason === "replacement")
      f.sessions.mockResolvedValue({
        version: 1,
        server: x.next,
        sessions: [{ sessionName: "same", liveSessionId: "live-session.replacement" }],
      });
    await x.route.observeCanonicalGeneration(observed);
    x.replace();
    x.emit("root-two");
    await expect(x.route.resolveConnection("same")).rejects.toThrow();
    expect(observed.mock.calls.every(([generation]) => generation === null)).toBe(true);
    expect(f.prepare).not.toHaveBeenCalled();
  },
);
it("does not retarget a changed server generation under the same daemon", async () => {
  const x = reconnectFixture(),
    observed = vi.fn();
  await x.route.observeCanonicalGeneration(observed);
  x.emit("root-one");
  await x.route.resolveConnection("same");
  expect(f.servers).not.toHaveBeenCalled();
  expect(f.prepare).toHaveBeenCalledWith("same", expect.objectContaining({ server: x.server }));
});
it("discards requalification overtaken by another daemon restart", async () => {
  const x = reconnectFixture(),
    observed = vi.fn();
  let finish!: (value: unknown) => void;
  f.sessions.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await x.route.observeCanonicalGeneration(observed);
  x.replace();
  x.emit("root-two");
  await vi.waitFor(() => expect(f.sessions).toHaveBeenCalled());
  x.replace("root-three");
  finish({
    version: 1,
    server: x.next,
    sessions: [{ sessionName: "same", liveSessionId: "live-session.one" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.mock.calls.every(([generation]) => generation === null)).toBe(true);
});

it("allows original scoped selection without a pinned live ID but requires reselection after daemon restart", async () => {
  const x = reconnectFixture();
  const route = applicationRouteConnection(x.handle, undefined, undefined, x.server);
  await route.resolveConnection("same");
  expect(f.prepare).toHaveBeenLastCalledWith("same", expect.objectContaining({ server: x.server }));
  x.replace();
  await expect(route.resolveConnection("same")).rejects.toThrow("Select the server session again");
});
