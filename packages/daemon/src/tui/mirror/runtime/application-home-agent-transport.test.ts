import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import { projectApplicationShellResource } from "../../../command-center/resources/application-shell.ts";
import {
  createApplicationHomeAgentTransport,
  type HomeAgentEventSocket,
} from "./application-home-agent-transport.ts";

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
const peer = {
  protocolVersion: daemon.protocolVersion,
  productVersion: daemon.productVersion,
  instanceId: daemon.instanceId,
  startedAt: daemon.startedAt,
};
const liveSessionId = "live-session.11111111111111111111";
const session = {
  id: `${daemon.instanceId}:${liveSessionId}`,
  liveSessionId,
  name: "session-one",
  workspaceName: "workspace-one",
  paneCount: 0,
};
const catalog = {
  version: 3,
  daemon: peer,
  intents: [],
  liveSessions: [
    {
      liveSessionId,
      sessionName: session.name,
      fleetSessionId: "session.11111111111111111111",
      paneCount: 0,
    },
  ],
};
const shell = {
  version: 2,
  daemon: peer,
  resource: projectApplicationShellResource({
    name: session.name,
    runtimeSessionId: "$1",
    dir: "/tmp/project",
    panes: [],
  }),
};

class Socket implements HomeAgentEventSocket {
  sent: unknown[] = [];
  closed = false;
  message: (data: { toString(): string }) => void = () => undefined;
  error: () => void = () => undefined;
  ended: () => void = () => undefined;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "error" | "close", listener: () => void): unknown;
  on(
    event: "message" | "error" | "close",
    listener: ((data: { toString(): string }) => void) | (() => void),
  ) {
    if (event === "message") this.message = listener as typeof this.message;
    else if (event === "error") this.error = listener as () => void;
    else this.ended = listener as () => void;
    return this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  emit(frame: unknown) {
    this.message({ toString: () => JSON.stringify(frame) });
  }
}

describe("Home agent production transport", () => {
  it("reads only shell V2 then verifies the live session incarnation with owner-authenticated no-cache requests", async () => {
    const paths: string[] = [];
    const adapter = createApplicationHomeAgentTransport({
      fetch: async (input, init) => {
        paths.push(String(input));
        expect(init).toMatchObject({
          method: "GET",
          cache: "no-store",
          redirect: "error",
          credentials: "omit",
        });
        expect(init?.headers).toMatchObject({ Authorization: "Bearer owner" });
        return Response.json(paths.length === 1 ? shell : catalog);
      },
    });
    expect((await adapter.fetchShell(daemon, session, new AbortController().signal)).version).toBe(
      2,
    );
    expect(paths.map((url) => new URL(url).pathname + new URL(url).search)).toEqual([
      "/api/project/session-one/application-shell?version=2",
      "/api/resources/workspace-catalog?version=3",
    ]);
  });

  it("rejects daemon mismatch and a reused session name after the shell read", async () => {
    for (const altered of [
      {
        ...catalog,
        liveSessions: [
          { ...catalog.liveSessions[0]!, liveSessionId: "live-session.22222222222222222222" },
        ],
      },
      { ...catalog, daemon: { ...peer, instanceId: "22222222-2222-4222-8222-222222222222" } },
    ]) {
      let count = 0;
      const adapter = createApplicationHomeAgentTransport({
        fetch: async () => Response.json(++count === 1 ? shell : altered),
      });
      await expect(
        adapter.fetchShell(daemon, session, new AbortController().signal),
      ).rejects.toThrow("incarnation changed");
    }
  });

  it("subscribes only read-only resource interests and waits for acknowledgement; gaps refresh observations", () => {
    const socket = new Socket();
    const ready: string[][] = [];
    const invalidations: (string | undefined)[] = [];
    let failures = 0;
    const adapter = createApplicationHomeAgentTransport({ createSocket: () => socket });
    const connection = adapter.connect(daemon, [session], {
      ready: (keys) => ready.push([...keys]),
      invalidate: (key) => invalidations.push(key),
      unavailable: () => failures++,
    });
    expect(socket.sent).toEqual([]);
    socket.emit({ type: "hello", daemon: peer, sessions: [], eventSequence: 0 });
    expect(JSON.stringify(socket.sent)).not.toContain("terminal-runtime");
    expect(socket.sent[0]).toMatchObject({
      legacyEvents: false,
      interests: [
        { resource: "workspace-catalog", workspaceName: null },
        { resource: "fleet-catalog", workspaceName: null },
        { resource: "application-shell", workspaceName: "workspace-one" },
      ],
    });
    expect(ready).toEqual([]);
    socket.emit({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    expect(ready).toEqual([[]]);
    socket.emit({
      type: "resource.changed",
      sequence: 1,
      workspaceName: "workspace-one",
      resource: "application-shell",
      revision: 1,
      causeOperationId: null,
    });
    expect(invalidations).toEqual([session.id]);
    socket.emit({ type: "resource.observed", sequence: 3 });
    expect(invalidations).toHaveLength(2);
    socket.emit({
      type: "snapshot-required",
      afterSequence: 3,
      oldestAvailableSequence: null,
      currentSequence: 4,
      reason: "journal-gap",
    });
    expect(invalidations).toHaveLength(3);
    connection.close();
    socket.error();
    expect(failures).toBe(0);
    expect(socket.closed).toBe(true);
  });

  it("degrades unavailable interests and retires wrong-daemon or malformed transports", () => {
    for (const malformed of [false, true]) {
      const socket = new Socket();
      let failed = 0;
      const adapter = createApplicationHomeAgentTransport({ createSocket: () => socket });
      adapter.connect(daemon, [session], {
        ready: () => undefined,
        invalidate: () => undefined,
        unavailable: () => failed++,
      });
      socket.emit(
        malformed
          ? { type: "no-such-frame" }
          : {
              type: "hello",
              daemon: { ...peer, instanceId: "22222222-2222-4222-8222-222222222222" },
              sessions: [],
            },
      );
      expect(failed).toBe(1);
      expect(socket.closed).toBe(true);
    }
    const socket = new Socket();
    const results: string[][] = [];
    const adapter = createApplicationHomeAgentTransport({ createSocket: () => socket });
    const connection = adapter.connect(daemon, [session], {
      ready: (keys) => results.push([...keys]),
      invalidate: () => undefined,
      unavailable: () => undefined,
    });
    socket.emit({ type: "hello", daemon: peer, sessions: [] });
    socket.emit({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [
        { resource: "application-shell", workspaceName: session.workspaceName },
      ],
    });
    expect(results).toEqual([[session.id]]);
    connection.close();
  });
});
