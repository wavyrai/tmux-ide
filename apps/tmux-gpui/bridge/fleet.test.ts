import type { MachineAgentGroup } from "../../../packages/daemon/src/lib/machine-agents.ts";
import { createFleetPreferences } from "./fleet-preferences.ts";
import { emptyFleetClientState } from "../../../packages/core/src/fleet-client-state.ts";
import { assertFleetSelectionCurrent } from "./fleet-selection-current.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMachineConnectionManager } from "../../../packages/daemon/src/lib/machine-connection-manager.ts";
import { createDaemonConnectionOwner } from "../../../packages/daemon/src/lib/daemon-connection-owner.ts";
import { createMachineCatalog } from "../../../packages/daemon/src/lib/machine-catalog.ts";
import type { HomeCatalogSnapshot } from "../../../packages/daemon/src/lib/home-catalog.ts";
import { createNativeFleet } from "./fleet.ts";

async function fixture(count = 1, preferences?: ReturnType<typeof createFleetPreferences>) {
  let catalog: ReturnType<typeof createMachineCatalog>;
  const info = {
    pid: 1,
    port: 4000,
    protocolVersion: 2,
    productVersion: "fixture",
    instanceId: randomUUID(),
    startedAt: "2026-10-11T00:00:00Z",
    bindHostname: "127.0.0.1" as const,
    authToken: "secret-must-never-cross-wire",
  };
  const manager = createMachineConnectionManager({
    createOwner: () =>
      createDaemonConnectionOwner({
        readLocal: () => info,
        isLocalAlive: async () => true,
        observeLocal: async () => () => {},
        connect: async () => ({
          daemon: info,
          baseUrl: "http://127.0.0.1:4000",
          closed: new Promise<void>(() => {}),
          dispose() {},
        }),
      }),
  });
  const profiles = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    label: `Build ${i}`,
    sshTarget: `build-${i}`,
    enabled: true,
  }));
  manager.initialize(profiles);
  await Promise.all(profiles.map((p) => manager.getMachine(p.id)!.ready));
  const emitters = new Map<string, (next: HomeCatalogSnapshot) => void>();
  const snapshot: HomeCatalogSnapshot = {
    phase: "live",
    daemonInstanceId: info.instanceId,
    note: null,
    sessions: [
      {
        id: "same",
        liveSessionId: "$1",
        workspaceName: "workspace",
        name: "Workspace",
        paneCount: 2,
        server: {
          serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
          generation: randomUUID(),
        },
      },
    ],
  };
  let agentGroups: MachineAgentGroup[] = [];
  let agentListener: ((groups: readonly MachineAgentGroup[]) => void) | undefined;
  let agentStarts = 0,
    agentStops = 0;
  let notifications = 0;
  const fleet = createNativeFleet(
    manager,
    () => {
      notifications++;
    },
    (manager) =>
      (catalog = createMachineCatalog({
        manager,
        createCatalog: (handle) => {
          let current = structuredClone(snapshot);
          const listeners = new Set<(value: HomeCatalogSnapshot) => void>();
          emitters.set(handle.id, (next) => {
            current = next;
            for (const listener of listeners) listener(next);
          });
          return {
            getSnapshot: () => current,
            start() {},
            retry() {},
            subscribe(listener) {
              listeners.add(listener);
              listener(current);
              return () => {
                listeners.delete(listener);
              };
            },
            dispose() {
              listeners.clear();
            },
          };
        },
      })),
    () => ({
      getSnapshot: () => agentGroups,
      subscribe(listener) {
        agentListener = listener;
        listener(agentGroups);
        return () => {
          agentListener = undefined;
        };
      },
      isCurrentTarget: () => true,
      start() {
        agentStarts++;
      },
      retry() {},
      loadMore() {},
      dispose() {
        agentStops++;
      },
    }),
    preferences,
  );
  fleet.start();
  return {
    fleet,
    setAgentGroups(value: MachineAgentGroup[]) {
      agentGroups = value;
      agentListener?.(value);
    },
    catalogSnapshot: () => catalog.getSnapshot(),
    manager,
    profiles,
    snapshot,
    emitters,
    notifications: () => notifications,
    agentCounts: () => ({ starts: agentStarts, stops: agentStops }),
    close() {
      fleet.dispose();
      manager.dispose();
    },
  };
}

test("native fleet projects credential-free groups and selects exact routes with duplicate session names", async () => {
  const f = await fixture();
  try {
    const groups = f.fleet.publication().groups;
    assert.equal(groups.length, 2);
    assert.notEqual(groups[0]!.sessions[0]!.selection, groups[1]!.sessions[0]!.selection);
    assert.equal(JSON.stringify(groups).includes("secret-must-never-cross-wire"), false);
    assert.equal(JSON.stringify(groups).includes("127.0.0.1"), false);
    const remote = f.fleet.select(groups[1]!.sessions[0]!.selection!);
    assert.equal(remote.handle.id, f.profiles[0]!.id);
    remote.assertCurrent();
    f.fleet.select(groups[0]!.sessions[0]!.selection!);
    assert.throws(remote.assertCurrent, /changed/);
    f.fleet.select(groups[1]!.sessions[0]!.selection!);
    assert.throws(remote.assertCurrent, /changed/);
    // Publications are detached; view mutation cannot change selection authority.
    groups[0]!.sessions[0]!.selection = "forged";
    assert.throws(() => f.fleet.select("forged"), /changed/);
  } finally {
    f.close();
  }
});

test("unavailable catalog revokes a displayed token and reconnect never replays it", async () => {
  const f = await fixture();
  try {
    const id = f.profiles[0]!.id;
    const token = f.fleet.publication().groups.find((g) => g.id === id)!.sessions[0]!.selection!;
    const selection = f.fleet.select(token);
    const key = f.fleet.publication().groups.find((g) => g.id === id)!.sessions[0]!.id;
    assert.ok(f.fleet.retainedFrameProof(key));
    f.emitters.get(id)!({
      phase: "unavailable",
      daemonInstanceId: null,
      sessions: [],
      note: "private diagnostic",
    });
    const failed = f.fleet.publication().groups.find((g) => g.id === id)!;
    assert.equal(failed.sessions[0]!.selection, null);
    assert.equal(f.fleet.retainedFrameProof(key), null);
    assert.throws(selection.assertCurrent, /changed/);
    assert.throws(() => f.fleet.select(token), /changed/);
    f.emitters.get(id)!(f.snapshot);
    assert.notEqual(
      f.fleet.publication().groups.find((g) => g.id === id)!.sessions[0]!.selection,
      token,
    );
    assert.throws(() => f.fleet.select(token), /changed/);
    assert.ok(f.fleet.publication().groups.find((g) => g.id === "local")!.sessions[0]!.selection);
  } finally {
    f.close();
  }
});

test("ordinary tmux sessions remain selectable before daemon workspace promotion", async () => {
  const f = await fixture();
  try {
    const session = { ...f.snapshot.sessions[0]! };
    delete session.workspaceName;
    f.emitters.get("local")!({ ...f.snapshot, sessions: [session] });
    const token = f.fleet.publication().groups.find((g) => g.id === "local")!.sessions[0]!
      .selection;
    assert.ok(token);
    const selected = f.fleet.select(token);
    assert.equal(selected.session.workspaceName, undefined);
    assert.equal(selected.session.liveSessionId, session.liveSessionId);
    selected.assertCurrent();
    f.emitters.get("local")!({
      ...f.snapshot,
      sessions: [{ ...session, workspaceName: "promoted" }],
    });
    selected.assertCurrent();
    assert.equal(
      f.fleet.publication().groups.find((g) => g.id === "local")!.sessions[0]!.selection,
      token,
    );
    f.emitters.get("local")!({
      ...f.snapshot,
      sessions: [{ ...session, server: { ...session.server!, generation: randomUUID() } }],
    });
    assert.throws(selected.assertCurrent, /changed/);
    assert.throws(() => f.fleet.select(token), /changed/);
  } finally {
    f.close();
  }
});

test("profile replacement retires borrowed selections; label edits preserve them", async () => {
  const f = await fixture();
  try {
    const profile = f.profiles[0]!;
    const token = f.fleet.publication().groups.find((g) => g.id === profile.id)!.sessions[0]!
      .selection!;
    const selection = f.fleet.select(token);
    f.manager.reconcile([{ ...profile, label: "Renamed" }]);
    selection.assertCurrent();
    assert.equal(f.fleet.publication().groups.find((g) => g.id === profile.id)!.label, "Renamed");
    f.manager.reconcile([{ ...profile, sshTarget: "replacement" }]);
    assert.throws(selection.assertCurrent, /changed/);
    assert.throws(() => f.fleet.select(token), /changed/);
    await f.manager.getMachine(profile.id)!.ready;
    assert.throws(() => f.fleet.select(token), /changed/);
  } finally {
    f.close();
  }
});

test("fleet publication is globally bounded and disposal leaves borrowed connections alive", async () => {
  const f = await fixture(5);
  try {
    const large = {
      ...f.snapshot,
      sessions: Array.from({ length: 300 }, (_, i) => ({
        ...f.snapshot.sessions[0]!,
        id: String(i),
        liveSessionId: `$${i}`,
      })),
    };
    for (const emit of f.emitters.values()) emit(large);
    const publication = f.fleet.publication();
    assert.equal(
      publication.groups.reduce((n, g) => n + g.sessions.length, 0),
      512,
    );
    assert.equal(
      publication.groups.reduce((n, g) => n + g.omittedSessions, 0),
      1800 - 512,
    );
    const token = publication.groups[0]!.sessions[0]!.selection!;
    const before = f.notifications();
    f.fleet.dispose();
    for (const emit of f.emitters.values()) emit(f.snapshot);
    assert.equal(f.notifications(), before);
    assert.throws(() => f.fleet.select(token), /changed/);
    assert.equal(f.manager.getMachine(f.profiles[0]!.id)!.endpoint().state, "ready");
  } finally {
    f.close();
  }
});

test("retry uses the captured disconnected handle, leaves siblings and selection alone, and consumes its token", async () => {
  const f = await fixture(2);
  try {
    const id = f.profiles[0]!.id;
    const sibling = f.manager.getMachine(f.profiles[1]!.id)!;
    const siblingEpoch = sibling.endpoint().epoch;
    const selected = f.manager.snapshot().selectedMachineId;
    const key = f.fleet.publication().groups.find((g) => g.id === id)!.sessions[0]!.id;
    const proof = f.fleet.retainedFrameProof(key);
    assert.ok(proof);
    f.manager.disconnect(id);
    assert.equal(f.fleet.retainedFrameProof(key), null);
    const token = f.fleet.publication().groups.find((g) => g.id === id)!.retry;
    assert.ok(token);
    assert.equal(f.fleet.publication().groups.find((g) => g.id === "local")!.retry, null);
    let unsubscribe = () => {};
    const recovered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Retry did not recover"));
      }, 2000);
      unsubscribe = f.manager.subscribe(() => {
        if (f.manager.getMachine(id)!.endpoint().state !== "ready") return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
    f.fleet.retry(token);
    assert.throws(() => f.fleet.retry(token), /changed/);
    await recovered;
    assert.ok(f.fleet.retainedFrameProof(key));
    assert.notEqual(f.fleet.retainedFrameProof(key), proof);
    assert.equal(f.manager.getMachine(f.profiles[1]!.id), sibling);
    assert.equal(sibling.endpoint().epoch, siblingEpoch);
    assert.equal(f.manager.snapshot().selectedMachineId, selected);
    assert.equal(f.manager.getMachine(id)!.endpoint().state, "ready");
    assert.deepEqual(f.fleet.publication().groups.find((g) => g.id === id)!.diagnostic, {
      phase: "ready",
      failure: null,
    });
  } finally {
    f.close();
  }
});

test("retry token cannot reconnect a removed or replaced saved machine", async () => {
  const f = await fixture();
  try {
    const profile = f.profiles[0]!;
    f.manager.disconnect(profile.id);
    const token = f.fleet.publication().groups.find((g) => g.id === profile.id)!.retry!;
    assert.ok(token);
    f.manager.reconcile([{ ...profile, sshTarget: "replacement" }]);
    assert.throws(() => f.fleet.retry(token), /changed/);
    await f.manager.getMachine(profile.id)!.ready;
    f.manager.disconnect(profile.id);
    const replacement = f.fleet.publication().groups.find((g) => g.id === profile.id)!.retry!;
    assert.ok(replacement);
    assert.notEqual(replacement, token);
    f.manager.reconcile([]);
    assert.throws(() => f.fleet.retry(replacement), /changed/);
    f.fleet.dispose();
    assert.throws(() => f.fleet.retry(replacement), /changed/);
  } finally {
    f.close();
  }
});

test("disconnect retires selected input authority, preserves profiles and siblings, and allows explicit retry", async () => {
  const f = await fixture(2);
  try {
    const profile = f.profiles[0]!;
    const group = () => f.fleet.publication().groups.find((g) => g.id === profile.id)!;
    const selected = f.fleet.select(group().sessions[0]!.selection!);
    const sibling = f.manager.getMachine(f.profiles[1]!.id)!;
    const epoch = sibling.endpoint().epoch;
    const profiles = f.manager
      .snapshot()
      .machines.map(({ id, label, kind, sshTarget }) => ({ id, label, kind, sshTarget }));
    const token = group().disconnect!;
    assert.ok(token);
    assert.equal(f.fleet.publication().groups.find((g) => g.id === "local")!.disconnect, null);
    f.fleet.disconnect(token);
    assert.throws(selected.assertCurrent, /changed/);
    assert.throws(() => f.fleet.disconnect(token), /changed/);
    assert.equal(group().disconnect, null);
    assert.ok(group().retry);
    assert.equal(f.manager.getMachine(profile.id)!.endpoint().state, "disconnected");
    assert.equal(f.manager.getMachine(sibling.id), sibling);
    assert.equal(sibling.endpoint().epoch, epoch);
    assert.deepEqual(
      f.manager
        .snapshot()
        .machines.map(({ id, label, kind, sshTarget }) => ({ id, label, kind, sshTarget })),
      profiles,
    );
    // Reconciliation with unchanged saved settings must not undo deliberate disconnect.
    f.manager.reconcile(f.profiles);
    assert.equal(f.manager.getMachine(profile.id)!.endpoint().state, "disconnected");
  } finally {
    f.close();
  }
});

test("disconnect tokens survive display edits but reject replaced, removed and disposed routes", async () => {
  const f = await fixture();
  try {
    const profile = f.profiles[0]!;
    const token = f.fleet.publication().groups.find((g) => g.id === profile.id)!.disconnect!;
    f.manager.reconcile([{ ...profile, label: "Renamed" }]);
    assert.equal(f.fleet.publication().groups.find((g) => g.id === profile.id)!.disconnect, token);
    f.manager.reconcile([{ ...profile, sshTarget: "replacement" }]);
    assert.throws(() => f.fleet.disconnect(token), /changed/);
    await f.manager.getMachine(profile.id)!.ready;
    const replacement = f.fleet.publication().groups.find((g) => g.id === profile.id)!.disconnect!;
    assert.ok(replacement);
    assert.notEqual(replacement, token);
    f.manager.reconcile([]);
    assert.throws(() => f.fleet.disconnect(replacement), /changed/);
    f.fleet.dispose();
    assert.throws(() => f.fleet.disconnect(replacement), /changed/);
  } finally {
    f.close();
  }
});

test("catalog failure does not hide disconnect for a still-connected SSH transport", async () => {
  const f = await fixture();
  try {
    const id = f.profiles[0]!.id;
    f.emitters.get(id)!({
      phase: "unavailable",
      daemonInstanceId: null,
      sessions: [],
      note: "fixture",
    });
    const group = f.fleet.publication().groups.find((g) => g.id === id)!;
    assert.equal(group.state, "disconnected");
    assert.deepEqual(group.diagnostic, { phase: "ready", failure: null });
    assert.equal(group.retry, null, "a catalog failure does not authorize transport retry");
    assert.ok(group.disconnect);
    f.fleet.disconnect(group.disconnect);
    assert.equal(f.manager.getMachine(id)!.endpoint().state, "disconnected");
  } finally {
    f.close();
  }
});

test("Home filter removal resets All while shared F7 observer and selected route survive", async () => {
  const f = await fixture();
  const home: (string | null)[] = [];
  let attention = 0;
  const stopHome = f.fleet.observeHomeAgents((value) => home.push(value.machineId));
  const stopAttention = f.fleet.observeAgents(() => attention++);
  try {
    const selected = f.manager.snapshot().selectedMachineId;
    const before = attention;
    assert.equal(f.fleet.filterHomeAgents(f.profiles[0]!.id), true);
    assert.equal(home.at(-1), f.profiles[0]!.id);
    assert.equal(attention, before);
    assert.equal(f.fleet.filterHomeAgents("removed"), false);
    assert.equal(home.at(-1), f.profiles[0]!.id);
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
    f.manager.reconcile([]);
    assert.equal(home.at(-1), null);
    assert.equal(f.manager.snapshot().selectedMachineId, selected);
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
    stopHome();
    assert.equal(f.agentCounts().stops, 0);
    stopAttention();
    assert.equal(f.agentCounts().stops, 1);
  } finally {
    stopHome();
    stopAttention();
    f.close();
  }
});

test("Home filter cannot select a machine omitted from the bounded publication", async () => {
  const f = await fixture(64);
  try {
    const visible = new Set(f.fleet.publication().groups.map((group) => group.id));
    const hidden = f.profiles.find((profile) => !visible.has(profile.id));
    assert.ok(hidden);
    assert.equal(f.fleet.filterHomeAgents(hidden.id), false);
  } finally {
    f.close();
  }
});

test("empty server routes use current catalog scope and preserve unscoped session rows", async () => {
  const f = await fixture();
  try {
    const scope = f.snapshot.sessions[0]!.server!;
    const empty = {
      serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
      generation: randomUUID(),
      label: "Empty",
      state: "online" as const,
    };
    f.emitters.get("local")!({
      ...f.snapshot,
      servers: [{ ...scope, label: "Default", state: "online" }, empty],
    });
    const group = f.fleet.publication().groups.find((group) => group.id === "local")!;
    assert.equal(group.sessions[0]!.serverId, scope.serverId);
    assert.equal(group.servers.length, 2);
    const token = group.servers[1]!.selection!;
    const selected = f.fleet.selectServer(token);
    selected.assertCurrent();
    assert.equal(selected.descriptor.serverId, empty.serverId);
    assert.equal(selected.descriptor.generation, empty.generation);
    // Same name is not same scope; missing/offline server never defaults elsewhere.
    f.emitters.get("local")!({ ...f.snapshot, servers: [{ ...empty, generation: randomUUID() }] });
    assert.throws(selected.assertCurrent, /changed/);
    assert.throws(() => f.fleet.selectServer(token), /changed/);
    const unscoped = f.fleet.publication().groups.find((group) => group.id === "local")!;
    assert.equal(unscoped.sessions.length, 1);
    assert.equal(unscoped.sessions[0]!.serverId, null);
  } finally {
    f.close();
  }
});

test("session beyond server display cap survives catalog updates but cannot authorize unlabeled creation", async () => {
  const f = await fixture();
  try {
    const selectedScope = f.snapshot.sessions[0]!.server!;
    const servers: { serverId: string; generation: string; label: string; state: "online" }[] =
      Array.from({ length: 32 }, () => ({
        serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
        generation: randomUUID(),
        label: "Other",
        state: "online" as const,
      }));
    servers.push({ ...selectedScope, label: "Omitted", state: "online" });
    const publish = () => f.emitters.get("local")!({ ...f.snapshot, servers });
    publish();
    const group = () => f.fleet.publication().groups.find((group) => group.id === "local")!;
    assert.equal(group().omittedServers, 1);
    assert.equal(group().sessions[0]!.serverId, null);
    const token = group().sessions[0]!.selection!;
    assert.ok(token);
    const selected = f.fleet.select(token);
    const hasPublishedServer = () =>
      group().servers.some((server) => server.id === selectedScope.serverId);
    assertFleetSelectionCurrent(selected, hasPublishedServer());
    publish();
    assert.equal(group().sessions[0]!.selection, token);
    assertFleetSelectionCurrent(selected, hasPublishedServer());
    assert.throws(
      () => assertFleetSelectionCurrent(selected, hasPublishedServer(), true),
      /changed/,
    );
    assert.throws(
      () => assertFleetSelectionCurrent({ ...selected, descriptor: selectedScope }, false),
      /changed/,
    );
  } finally {
    f.close();
  }
});

test("removing the selected saved profile retires only its route and leaves sibling transport current", async () => {
  const f = await fixture(2);
  try {
    const profile = f.profiles[0]!;
    const token = f.fleet.publication().groups.find((group) => group.id === profile.id)!
      .sessions[0]!.selection!;
    const selected = f.fleet.select(token);
    const sibling = f.manager.getMachine(f.profiles[1]!.id)!;
    const siblingEpoch = sibling.endpoint().epoch;
    const siblingReady = sibling.read();
    f.manager.reconcile([f.profiles[1]!]);
    assert.equal(f.manager.getMachine(profile.id), null);
    assert.throws(selected.assertCurrent, /changed/);
    assert.throws(() => f.fleet.select(token), /changed/);
    assert.equal(f.manager.getMachine(sibling.id), sibling);
    assert.equal(sibling.endpoint().epoch, siblingEpoch);
    assert.deepEqual(sibling.read(), siblingReady);
    assert.equal(f.manager.snapshot().selectedMachineId, "local");
    const remaining = f.fleet.publication().groups.find((group) => group.id === sibling.id)!;
    f.fleet.select(remaining.sessions[0]!.selection!).assertCurrent();
  } finally {
    f.close();
  }
});
test("favorite cap reprioritization resets displaced Home filter without restarting F7", async () => {
  let state = emptyFleetClientState();
  const daemon = {
    protocolVersion: 1,
    productVersion: "fixture",
    instanceId: randomUUID(),
    startedAt: "2026-10-13T00:00:00Z",
  };
  const owner = {
    kind: "local" as const,
    ...daemon,
    assertCurrent() {},
    async request() {
      return Response.json({ daemon, state });
    },
  };
  const preferences = createFleetPreferences({ getLocalOwner: () => owner });
  await preferences.refresh();
  const f = await fixture(64, preferences);
  const home: (string | null)[] = [];
  let attention = 0;
  const stopHome = f.fleet.observeHomeAgents((value) => home.push(value.machineId));
  const stopAttention = f.fleet.observeAgents(() => attention++);
  try {
    const visible = f.fleet.publication().groups;
    const boundary = visible.at(-1)!;
    const hidden = f
      .catalogSnapshot()
      .groups.find((group) => !visible.some((v) => v.id === group.id))!;
    assert.ok(hidden);
    assert.equal(f.fleet.filterHomeAgents(boundary.id), true);
    assert.equal(home.at(-1), boundary.id);
    const before = attention;
    state = { ...state, favorites: [hidden.sessions[0]!.id] };
    await preferences.refresh();
    f.fleet.refreshPreferences();
    assert.ok(!f.fleet.publication().groups.some((group) => group.id === boundary.id));
    assert.equal(home.at(-1), null);
    assert.equal(attention, before);
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
  } finally {
    stopHome();
    stopAttention();
    f.close();
    preferences.dispose();
  }
});

test("Home, F7 and query-changing F5 retain one scanner and independent subscriber lifetimes", async () => {
  const f = await fixture();
  const stopHome = f.fleet.observeHomeAgents(() => {});
  const stopAttention = f.fleet.observeAgents(() => {});
  let published = 0;
  const stopPalette = f.fleet.observePaletteAgents("agent alpha", () => published++);
  try {
    assert.equal(published, 1);
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
    stopPalette.update("agent beta");
    assert.equal(published, 2);
    stopHome();
    stopPalette.dispose();
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
    stopAttention();
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 1 });
  } finally {
    f.close();
  }
});

test("palette-only query replacement keeps its scanner until explicit dismissal", async () => {
  const f = await fixture();
  try {
    let publications = 0;
    const palette = f.fleet.observePaletteAgents("agent alpha", () => publications++);
    palette.update("agent zebra");
    assert.equal(publications, 2);
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
    palette.dispose();
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 1 });
  } finally {
    f.close();
  }
});

test("history resolves exact canonical sessions beyond publication caps without cached tokens", async () => {
  const f = await fixture(0);
  try {
    const source = f.snapshot.sessions[0]!;
    f.emitters.get("local")!({
      ...f.snapshot,
      sessions: Array.from({ length: 140 }, (_, i) => ({
        ...source,
        id: `source-${i}`,
        liveSessionId: `$${i}`,
        name: "Duplicate",
      })),
    });
    const rows = f.catalogSnapshot().groups.find((g) => g.id === "local")!.sessions;
    const target = rows.find((s) => s.liveSessionId === "$139")!;
    assert.ok(target);
    assert.equal(
      f.fleet.publication().groups[0]!.sessions.some((s) => s.sessionId === "$139"),
      false,
    );
    assert.equal(f.fleet.resolveCanonical(target.id), true);
    assert.equal(
      f.fleet.canonicalKey("local", target.server!.serverId, target.server!.generation, "$139"),
      target.id,
    );
    const selected = f.fleet.selectCanonical(target.id);
    assert.equal(selected.session.liveSessionId, "$139");
    selected.assertCurrent();
    f.emitters.get("local")!({
      ...f.snapshot,
      sessions: [
        {
          ...source,
          id: "replacement",
          liveSessionId: "$139",
          server: { ...source.server!, generation: randomUUID() },
        },
      ],
    });
    assert.throws(selected.assertCurrent, /changed/);
    assert.equal(f.fleet.resolveCanonical(target.id), false);
    assert.throws(() => f.fleet.selectCanonical(target.id), /changed/);
    assert.equal(
      f.fleet.canonicalKey("local", target.server!.serverId, target.server!.generation, "$139"),
      null,
    );
  } finally {
    f.close();
  }
});

test("history route distinguishes duplicate labels and live IDs by machine and fresh owner", async () => {
  const f = await fixture();
  try {
    const groups = f.catalogSnapshot().groups;
    const local = groups.find((g) => g.id === "local")!.sessions[0]!;
    const remote = groups.find((g) => g.id !== "local")!.sessions[0]!;
    assert.notEqual(local.id, remote.id);
    assert.equal(f.fleet.selectCanonical(remote.id).handle.id, remote.machineId);
    const selected = f.fleet.selectCanonical(local.id);
    f.emitters.get("local")!({
      ...f.snapshot,
      phase: "unavailable",
      sessions: [],
      daemonInstanceId: null,
    });
    assert.throws(selected.assertCurrent, /changed/);
    assert.equal(f.fleet.resolveCanonical(local.id), false);
    assert.equal(f.fleet.resolveCanonical(remote.id), true);
  } finally {
    f.close();
  }
});

test("persistent Workspace, F5 and F7 share one scanner through query changes and independent cancellation", async () => {
  const f = await fixture();
  try {
    const workspace = f.fleet.observeWorkspaceAgents(() => {});
    const attention = f.fleet.observeAgents(() => {});
    const palette = f.fleet.observePaletteAgents("first", () => {});
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
    palette.update("second");
    palette.dispose();
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
    attention();
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 0 });
    workspace();
    assert.deepEqual(f.agentCounts(), { starts: 1, stops: 1 });
  } finally {
    f.close();
  }
});

test("retained tab metadata reads uncapped exact scoped source and resets incomplete observations", async () => {
  const f = await fixture();
  const group = f.catalogSnapshot().groups.find((g) => g.id === f.profiles[0]!.id)!;
  const session = group.sessions[0]!;
  const stop = f.fleet.observeAgents(() => {});
  const observation = {
    phase: "live" as const,
    rows: [],
    observedSessions: 1,
    totalSessions: 1,
    loadingSessions: 0,
    unavailableSessions: 0,
    truncatedSessions: 0,
    refreshingSessionKeys: [],
    unavailableSessionKeys: [],
    note: null,
  };
  const agents = Array.from({ length: 300 }, (_, i) => ({
    id: `agent-${i}`,
    key: `key-${i}`,
    machineId: group.id,
    sessionKey: session.sourceId,
    sessionName: session.name,
    liveSessionId: session.liveSessionId!,
    server: session.server!,
    daemonInstanceId: f.manager.getMachine(group.id)!.read()!.instanceId,
    agentId: `agent-${i}`,
    paneId: `pane-${i}`,
    name: "Same",
    harness: "codex",
    activity: "running" as const,
    attention: false,
    projectName: "",
    nativeIdentity: null,
    interactionEndpoint: null,
    disabled: false,
  }));
  const source = { machineId: group.id, available: true, agents, observation };
  f.setAgentGroups([source]);
  assert.equal(f.fleet.tabObservation(session.id)!.length, 300);
  const target = f.fleet.retainedTarget(session.id)!;
  assert.ok(target.identity);
  assert.equal(target.label, session.name);
  f.setAgentGroups([
    {
      ...source,
      agents: [...agents, { ...agents[0]!, server: { ...session.server!, generation: "other" } }],
    },
  ]);
  assert.equal(f.fleet.tabObservation(session.id)!.length, 300);
  f.setAgentGroups([{ ...source, agents: [] }]);
  assert.deepEqual(f.fleet.tabObservation(session.id), []);
  f.setAgentGroups([
    {
      ...source,
      agents: [],
      observation: { ...observation, totalSessions: 0, observedSessions: 0 },
    },
  ]);
  assert.equal(f.fleet.tabObservation(session.id), null);
  f.setAgentGroups([
    { ...source, agents: [], observation: { ...observation, observedSessions: 0 } },
  ]);
  assert.equal(f.fleet.tabObservation(session.id), null);
  f.setAgentGroups([{ ...source, observation: { ...observation, truncatedSessions: 1 } }]);
  assert.equal(f.fleet.tabObservation(session.id), null);
  stop();
  f.fleet.dispose();
  f.manager.dispose();
});

test("recovery resolves fresh generations only for the same machine server and live session", async () => {
  const f = await fixture();
  try {
    const id = f.profiles[0]!.id;
    const key = f.fleet.publication().groups.find((g) => g.id === id)!.sessions[0]!.id;
    const resolve = f.fleet.recoveryRoute(key);
    assert.ok(resolve);
    assert.equal(resolve(), key);
    f.emitters.get(id)!({ phase: "unavailable", daemonInstanceId: null, sessions: [], note: null });
    assert.equal(resolve(), null);
    const fresh = structuredClone(f.snapshot);
    fresh.sessions[0]!.server!.generation = randomUUID();
    f.emitters.get(id)!(fresh);
    const nextKey = resolve();
    assert.ok(nextKey);
    assert.equal(
      f.fleet.selectCanonical(nextKey).session.server!.generation,
      fresh.sessions[0]!.server!.generation,
    );
    const replacement = {
      ...fresh,
      sessions: fresh.sessions.map((session) => ({ ...session, liveSessionId: "$99" })),
    };
    f.emitters.get(id)!(replacement);
    assert.equal(resolve(), null, "same display name must not retarget recovery");
    f.emitters.get(id)!(fresh);
    assert.ok(resolve());
    f.close();
    assert.equal(resolve(), null);
  } finally {
    f.close();
  }
});
