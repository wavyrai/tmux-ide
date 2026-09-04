import type { ApplicationShellResourceV2, CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import {
  createApplicationHomeAgentObserver,
  type HomeAgentObservationHandlers,
} from "./application-home-agent-observer.ts";
import type { ApplicationHomeCatalogSnapshot } from "./application-home-catalog.ts";

const daemon: CanonicalDaemonInfo = {
  pid: 1,
  port: 4000,
  protocolVersion: 1,
  productVersion: "test",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-09-04T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner",
};
const catalog = (count = 1, suffix = ""): ApplicationHomeCatalogSnapshot => ({
  phase: "live",
  daemonInstanceId: daemon.instanceId,
  note: null,
  sessions: Array.from({ length: count }, (_, index) => ({
    id: `${daemon.instanceId}:incarnation-${index}${suffix}`,
    liveSessionId: `incarnation-${index}${suffix}`,
    name: `session-${index}`,
    paneCount: 1,
  })),
});
const shell = (name = "Agent"): ApplicationShellResourceV2 =>
  ({
    version: 2,
    daemon,
    resource: {
      project: { name: "Project" },
      workspace: {
        sidebar: {
          agents: [
            {
              id: "agent.one",
              paneId: "pane.one",
              name,
              harness: "codex",
              activity: "running",
              attention: false,
            },
          ],
        },
      },
    },
  }) as unknown as ApplicationShellResourceV2;
const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

function rig() {
  const reads: {
    name: string;
    signal: AbortSignal;
    resolve(value: ApplicationShellResourceV2): void;
    reject(error: Error): void;
  }[] = [];
  const connections: { handlers: HomeAgentObservationHandlers; closed: boolean }[] = [];
  const observer = createApplicationHomeAgentObserver({
    readDaemon: () => daemon,
    fetchShell(_daemon, session, signal) {
      return new Promise((resolve, reject) =>
        reads.push({ name: session.name, signal, resolve, reject }),
      );
    },
    connect(_daemon, _sessions, handlers) {
      const connection = { handlers, closed: false };
      connections.push(connection);
      return {
        close() {
          connection.closed = true;
        },
      };
    },
  });
  return { observer, reads, connections };
}

describe("Home agent observer", () => {
  it("explains an unopened ordinary session without promoting it and recovers after catalog registration", async () => {
    const r = rig();
    r.observer.adoptCatalog(catalog());
    r.observer.setActive(true);
    r.connections[0]!.handlers.ready([]);
    await settle();
    r.reads[0]!.reject(new Error("Agent observation returned HTTP 404."));
    await settle();
    expect(r.observer.getSnapshot()).toMatchObject({
      phase: "unavailable",
      observedSessions: 0,
      totalSessions: 1,
    });
    expect(r.observer.getSnapshot().note).toContain("Open a session in Terminals");
    const registered = catalog();
    r.observer.adoptCatalog({
      ...registered,
      sessions: registered.sessions.map((session) => ({
        ...session,
        workspaceName: "workspace-one",
      })),
    });
    r.connections[1]!.handlers.ready([]);
    await settle();
    r.reads[1]!.resolve(shell());
    await settle();
    expect(r.observer.getSnapshot()).toMatchObject({
      phase: "live",
      observedSessions: 1,
      totalSessions: 1,
      note: null,
    });
    r.observer.dispose();
  });

  it("owns no resources inactive and waits for observation acknowledgement before two bounded reads", async () => {
    const r = rig();
    r.observer.adoptCatalog(catalog(4));
    expect(r.connections).toHaveLength(0);
    r.observer.setActive(true);
    await settle();
    expect(r.reads).toHaveLength(0);
    r.connections[0]!.handlers.ready([]);
    await settle();
    expect(r.reads).toHaveLength(2);
    r.reads[0]!.resolve(shell());
    await settle();
    expect(r.reads).toHaveLength(3);
    r.observer.dispose();
    expect(r.connections[0]!.closed).toBe(true);
    expect(r.reads[1]!.signal.aborted).toBe(true);
  });

  it("retains rows and selection identity while refreshing but rejects stale activation", async () => {
    const r = rig();
    r.observer.adoptCatalog(catalog());
    r.observer.setActive(true);
    r.connections[0]!.handlers.ready([]);
    await settle();
    r.reads[0]!.resolve(shell());
    await settle();
    const row = r.observer.getSnapshot().rows[0]!;
    expect(r.observer.isCurrentTarget(row)).toBe(true);
    r.observer.invalidate(row.sessionKey);
    expect(r.observer.getSnapshot().rows[0]!.key).toBe(row.key);
    expect(r.observer.getSnapshot().refreshingSessionKeys).toEqual([row.sessionKey]);
    expect(r.observer.isCurrentTarget(row)).toBe(false);
    await settle();
    r.reads[1]!.resolve(shell("Renamed"));
    await settle();
    expect(r.observer.isCurrentTarget(row)).toBe(true);
    expect(r.observer.getSnapshot().rows[0]!.name).toBe("Renamed");
    r.observer.dispose();
  });

  it("coalesces a burst during an active read and discards the superseded response", async () => {
    const r = rig();
    r.observer.adoptCatalog(catalog());
    r.observer.setActive(true);
    r.connections[0]!.handlers.ready([]);
    await settle();
    for (let index = 0; index < 20; index++) r.observer.invalidate();
    r.reads[0]!.resolve(shell("stale"));
    await settle();
    expect(r.reads).toHaveLength(2);
    expect(r.observer.getSnapshot().rows).toEqual([]);
    r.reads[1]!.resolve(shell("fresh"));
    await settle();
    expect(r.observer.getSnapshot().rows[0]!.name).toBe("fresh");
    r.observer.dispose();
  });

  it("rejects late removed/recreated-session responses and does not exceed two pending reads", async () => {
    const r = rig();
    r.observer.adoptCatalog(catalog(2));
    r.observer.setActive(true);
    r.connections[0]!.handlers.ready([]);
    await settle();
    r.observer.adoptCatalog(catalog(1, "new"));
    r.connections[1]!.handlers.ready([]);
    await settle();
    expect(r.reads).toHaveLength(2);
    expect(r.reads[0]!.signal.aborted).toBe(true);
    r.reads[0]!.resolve(shell("old"));
    await settle();
    expect(r.reads).toHaveLength(3);
    expect(r.observer.getSnapshot().rows).toEqual([]);
    r.reads[2]!.resolve(shell("new"));
    await settle();
    expect(r.observer.getSnapshot().rows[0]!.liveSessionId).toContain("new");
    r.observer.dispose();
  });

  it("reports partial failures honestly and preserves successful sessions", async () => {
    const r = rig();
    r.observer.adoptCatalog(catalog(2));
    r.observer.setActive(true);
    r.connections[0]!.handlers.ready([]);
    await settle();
    r.reads[0]!.resolve(shell());
    r.reads[1]!.reject(new Error("offline"));
    await settle();
    expect(r.observer.getSnapshot()).toMatchObject({
      phase: "partial",
      observedSessions: 1,
      unavailableSessions: 1,
      totalSessions: 2,
    });
    expect(r.observer.getSnapshot().rows).toHaveLength(1);
    r.connections[0]!.handlers.unavailable();
    expect(r.observer.getSnapshot().phase).toBe("unavailable");
    expect(r.observer.isCurrentTarget(r.observer.getSnapshot().rows[0]!)).toBe(false);
    r.observer.dispose();
  });

  it("makes capped coverage explicit and allows load more without losing existing row keys", async () => {
    const r = rig();
    r.observer.adoptCatalog(catalog(33));
    r.observer.setActive(true);
    r.connections[0]!.handlers.ready([]);
    await settle();
    expect(r.observer.getSnapshot().truncatedSessions).toBe(1);
    r.reads[0]!.resolve(shell());
    await settle();
    const key = r.observer.getSnapshot().rows[0]!.key;
    r.observer.loadMore();
    expect(r.observer.getSnapshot().truncatedSessions).toBe(0);
    expect(r.observer.getSnapshot().rows[0]!.key).toBe(key);
    r.observer.dispose();
  });

  it("reopens with a fresh read and fences callbacks after disposal", async () => {
    const r = rig();
    r.observer.adoptCatalog(catalog());
    r.observer.setActive(true);
    r.connections[0]!.handlers.ready([]);
    await settle();
    r.reads[0]!.resolve(shell());
    await settle();
    r.observer.setActive(false);
    expect(r.connections[0]!.closed).toBe(true);
    r.observer.setActive(true);
    r.connections[1]!.handlers.ready([]);
    await settle();
    expect(r.reads).toHaveLength(2);
    r.observer.dispose();
    r.reads[1]!.resolve(shell("late"));
    r.connections[1]!.handlers.invalidate();
    await settle();
    expect(r.observer.getSnapshot().rows).toEqual([]);
  });

  it("does not publish retired empty slots when an in-flight refresh settles after Home hides", async () => {
    const r = rig();
    const published: string[][] = [];
    r.observer.subscribe((snapshot) => published.push(snapshot.rows.map((row) => row.key)));
    r.observer.adoptCatalog(catalog());
    r.observer.setActive(true);
    r.connections[0]!.handlers.ready([]);
    await settle();
    r.reads[0]!.resolve(shell());
    await settle();
    const key = r.observer.getSnapshot().rows[0]!.key;
    r.observer.invalidate();
    await settle();
    expect(r.reads).toHaveLength(2);
    const publicationsBeforeHide = published.length;
    r.observer.setActive(false);
    expect(r.reads[1]!.signal.aborted).toBe(true);
    r.reads[1]!.resolve(shell("retired"));
    await settle();
    expect(published).toHaveLength(publicationsBeforeHide);
    expect(published.at(-1)).toEqual([key]);

    // The retired read still releases the shared concurrency budget so a new
    // Home lifetime can make progress and publish authoritative rows.
    r.observer.setActive(true);
    r.connections[1]!.handlers.ready([]);
    await settle();
    expect(r.reads).toHaveLength(3);
    r.reads[2]!.resolve(shell("current"));
    await settle();
    expect(r.observer.getSnapshot().rows[0]!.name).toBe("current");
    expect(published.at(-1)).toEqual([key]);
    r.observer.dispose();
  });
});
