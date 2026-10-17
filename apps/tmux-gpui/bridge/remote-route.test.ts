import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../../../packages/contracts/src/index.ts";
import type { DaemonConnectionEndpoint } from "../../../packages/daemon/src/lib/daemon-connection-owner.ts";
import { localPreviewHostProof } from "./discovery.ts";
import { createRemotePreviewRoute, RemoteRouteError } from "./remote-route.ts";

function fixture() {
  const daemon = Object.freeze({
    pid: 1234,
    port: 4000,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "2.9.5",
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    bindHostname: "127.0.0.1" as const,
    authToken: "test-private-token",
    environmentId: randomUUID(),
  });
  let endpoint: DaemonConnectionEndpoint = {
    kind: "ssh",
    label: "test-machine",
    remote: daemon,
    localBaseUrl: "http://127.0.0.1:43210",
    epoch: 2,
    state: "ready",
  };
  const listeners = new Set<() => void>();
  const generations = new Set<(generation: string | null) => void>();
  const owner = {
    endpoint: () => endpoint,
    async observe(listener: (generation: string | null) => void) {
      generations.add(listener);
      return () => {
        generations.delete(listener);
      };
    },
    observeConnection(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const server = {
    serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
    generation: randomUUID(),
    label: "remote",
    state: "online",
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/identity")) return Response.json({ ...daemon, ok: true });
    if (String(url).endsWith("/capabilities"))
      return Response.json({
        status: "ok",
        daemon: {
          protocolVersion: daemon.protocolVersion,
          productVersion: daemon.productVersion,
          instanceId: daemon.instanceId,
          startedAt: daemon.startedAt,
          environmentId: daemon.environmentId,
        },
        capabilities: { appWindowMutation: { available: false, reason: "not supported" } },
      });
    return Response.json({ version: 1, servers: [server] });
  };
  return {
    daemon,
    server,
    owner,
    listeners,
    generations,
    calls,
    request,
    change(patch: Partial<DaemonConnectionEndpoint>, generationOnly = false) {
      endpoint = { ...endpoint, ...patch };
      for (const listener of generations) listener(null);
      if (!generationOnly) for (const listener of listeners) listener();
    },
  };
}

test("remote route verifies both identities before inventory and never grants local editor proof", async () => {
  const f = fixture();
  const route = await createRemotePreviewRoute(f.owner, { request: f.request });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0]!.init?.headers, undefined);
  assert.equal(
    (f.calls[1]!.init?.headers as Record<string, string>).Authorization,
    `Bearer ${f.daemon.authToken}`,
  );
  assert.deepEqual(route.host.scope, {
    serverId: f.server.serverId,
    generation: f.server.generation,
  });
  assert.equal(localPreviewHostProof(route.host), null);
  assert.equal(Object.isFrozen(route.host.scope), true);
  route.assertCurrent();
  await route.verify();
  route.dispose();
  route.dispose();
  assert.equal(route.signal.aborted, true);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.generations.size, 0);
  assert.throws(route.assertCurrent, /connection changed/);
  assert.equal(f.owner.endpoint().state, "ready"); // Route does not own SSH lifetime.
});

test("identity mismatch never sends a bearer credential", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    createRemotePreviewRoute(f.owner, {
      request: async (_url, init) => {
        calls++;
        assert.equal(init?.headers, undefined);
        return Response.json({ ...f.daemon, ok: true, instanceId: randomUUID() });
      },
    }),
    (error: unknown) => error instanceof RemoteRouteError && error.category === "identity",
  );
  assert.equal(calls, 1);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.generations.size, 0);
});

test("retiring during inventory discards a late response even if fetch ignores abort", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: AbortSignal | null | undefined;
  const result = createRemotePreviewRoute(f.owner, {
    request: async (url, init) => {
      if (!String(url).endsWith("/identity") && !String(url).endsWith("/capabilities")) {
        signal = init?.signal;
        entered();
        await gate;
      }
      return f.request(url, init);
    },
  });
  await pending;
  f.change({ epoch: 3 });
  assert.equal(signal?.aborted, true);
  release();
  await assert.rejects(result, /connection changed/);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.generations.size, 0);
});

test("connection changes invalidate published routes immediately", async () => {
  for (const patch of [
    { state: "disconnected" as const },
    { epoch: 4 },
    { localBaseUrl: "http://127.0.0.1:43211" },
  ]) {
    const f = fixture();
    const route = await createRemotePreviewRoute(f.owner, { request: f.request });
    f.change(patch, true);
    assert.equal(route.signal.aborted, true);
    assert.throws(route.assertCurrent, /connection changed/);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.generations.size, 0);
  }
});

test("parent cancellation aborts route and removes its owner listener", async () => {
  for (const before of [false, true]) {
    const f = fixture();
    const controller = new AbortController();
    if (before) controller.abort();
    const pending = createRemotePreviewRoute(f.owner, {
      request: f.request,
      signal: controller.signal,
    });
    if (before) {
      await assert.rejects(pending, /connection changed/);
      assert.equal(f.calls.length, 0);
    } else {
      const route = await pending;
      controller.abort();
      assert.equal(route.signal.aborted, true);
    }
    assert.equal(f.listeners.size, 0);
    assert.equal(f.generations.size, 0);
  }
});

test("ambiguous and absent server scopes are rejected with fixed guidance", async () => {
  for (const count of [0, 2]) {
    const f = fixture();
    await assert.rejects(
      createRemotePreviewRoute(f.owner, {
        request: async (url, init) =>
          String(url).endsWith("/identity") || String(url).endsWith("/capabilities")
            ? f.request(url, init)
            : Response.json({
                version: 1,
                servers: Array.from({ length: count }, () => ({
                  ...f.server,
                  serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
                })),
              }),
      }),
      (error: unknown) =>
        error instanceof RemoteRouteError &&
        error.category === (count ? "multiple-servers" : "no-server"),
    );
    assert.equal(f.listeners.size, 0);
    assert.equal(f.generations.size, 0);
  }
});

test("private parser and network failures cannot escape route diagnostics", async () => {
  const f = fixture();
  await assert.rejects(
    createRemotePreviewRoute(f.owner, {
      request: async () => {
        throw new Error(f.daemon.authToken);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteRouteError);
      assert.equal(JSON.stringify(error).includes(f.daemon.authToken), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.equal(f.listeners.size, 0);
  assert.equal(f.generations.size, 0);
});

test("route snapshots caller options and retains original cancellation ownership", async () => {
  const f = fixture();
  const original = new AbortController();
  const replacement = new AbortController();
  const options = { signal: original.signal, request: f.request };
  const pending = createRemotePreviewRoute(f.owner, options);
  options.signal = replacement.signal;
  options.request = async () => {
    throw new Error("replacement must not run");
  };
  const route = await pending;
  await route.verify();
  replacement.abort();
  assert.equal(route.signal.aborted, false);
  original.abort();
  assert.equal(route.signal.aborted, true);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.generations.size, 0);
});

test("invalid endpoints fail before network access", async () => {
  for (const patch of [
    { kind: "local" as const },
    { state: "connecting" as const },
    { remote: null },
    { localBaseUrl: "https://example.com" },
  ]) {
    const f = fixture();
    f.change(patch);
    await assert.rejects(
      createRemotePreviewRoute(f.owner, { request: f.request }),
      RemoteRouteError,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.generations.size, 0);
  }
});

test("explicit remote server scope selects its exact generation without first-server fallback", async () => {
  for (const mode of ["match", "restarted", "offline", "missing", "duplicate"] as const) {
    const f = fixture();
    const other = { ...f.server, serverId: `tmux-server.${randomUUID().replaceAll("-", "")}` };
    const scope = { serverId: f.server.serverId, generation: f.server.generation };
    const selected =
      mode === "restarted"
        ? { ...f.server, generation: randomUUID() }
        : mode === "offline"
          ? { ...f.server, state: "offline", generation: null }
          : f.server;
    const request: typeof fetch = async (url, init) =>
      String(url).endsWith("/identity") || String(url).endsWith("/capabilities")
        ? f.request(url, init)
        : Response.json({
            version: 1,
            servers: [
              other,
              ...(mode === "missing" ? [] : [selected]),
              ...(mode === "duplicate" ? [selected] : []),
            ],
          });
    if (mode === "match") {
      const route = await createRemotePreviewRoute(f.owner, { request, scope });
      assert.deepEqual(route.host.scope, scope);
      route.dispose();
    } else {
      await assert.rejects(createRemotePreviewRoute(f.owner, { request, scope }), (error) =>
        mode === "duplicate"
          ? error instanceof Error
          : error instanceof RemoteRouteError && error.category === "server-changed",
      );
    }
    assert.equal(f.listeners.size, 0);
    assert.equal(f.generations.size, 0);
  }
});

test("remote scope is captured before awaits and malformed scope does not access the network", async () => {
  const f = fixture();
  const scope = { serverId: f.server.serverId, generation: f.server.generation };
  const expected = { ...scope };
  const pending = createRemotePreviewRoute(f.owner, { request: f.request, scope });
  scope.generation = randomUUID();
  const route = await pending;
  assert.deepEqual(route.host.scope, expected);
  route.dispose();
  const before = f.calls.length;
  await assert.rejects(
    createRemotePreviewRoute(f.owner, {
      request: f.request,
      scope: { ...scope, serverId: "invalid-secret" },
    }),
    (error) =>
      error instanceof RemoteRouteError &&
      error.category === "server-changed" &&
      !error.message.includes("secret"),
  );
  assert.equal(f.calls.length, before);
});

test("remote retirement reports a fixed reason without disclosing endpoint data", async () => {
  const f = fixture();
  const reasons: string[] = [];
  const route = await createRemotePreviewRoute(f.owner, {
    request: f.request,
    diagnostic: (reason) => reasons.push(reason),
  });
  f.change({ state: "connecting" });
  assert.equal(route.signal.aborted, true);
  assert.deepEqual(reasons, ["transport-state"]);
  assert.equal(JSON.stringify(reasons).includes("test-private-token"), false);
});

test("throwing diagnostics cannot prevent remote route retirement", async () => {
  const f = fixture();
  const route = await createRemotePreviewRoute(f.owner, {
    request: f.request,
    diagnostic: () => {
      throw new Error("observer");
    },
  });
  f.change({ epoch: 3 });
  assert.equal(route.signal.aborted, true);
});
