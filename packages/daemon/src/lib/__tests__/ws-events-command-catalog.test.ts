import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  broadcastResourceChanged,
  handleWsEventsConnection,
  _resetResourceEventJournalForTests,
} from "../../command-center/ws-events.ts";

vi.mock("../../command-center/discovery.ts", () => ({
  discoverSessions: vi.fn(() => []),
  buildOverviews: vi.fn(() => []),
  buildProjectDetail: vi.fn(() => null),
}));

const identity = {
  protocolVersion: 1,
  productVersion: "2.9.0",
  instanceId: "7b2d6b6e-1f1a-4c1e-9d6b-1f2a3b4c5d6e",
  startedAt: "2026-11-09T00:00:00.000Z",
} as const;

class Socket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  receive(value: unknown) {
    this.emit("message", JSON.stringify(value), false);
  }
  disconnect() {
    this.readyState = 3;
    this.emit("close");
  }
}

afterEach(() => _resetResourceEventJournalForTests());

it("delivers command-catalog changes to a client that subscribed the way the TUI palette does", async () => {
  const subscribed = new Socket();
  const other = new Socket();
  handleWsEventsConnection(subscribed, identity, { mode: "semantic" });
  handleWsEventsConnection(other, identity, { mode: "semantic" });
  try {
    subscribed.receive({
      type: "subscribe",
      sessions: [],
      interests: [{ resource: "command-catalog", workspaceName: null }],
      legacyEvents: false,
    });
    other.receive({ type: "subscribe", sessions: [], interests: [], legacyEvents: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    broadcastResourceChanged(
      { workspaceName: null, resource: "command-catalog" },
      identity.instanceId,
    );
    const frames = (socket: Socket) =>
      socket.sent.map((value) => JSON.parse(value) as { type: string; resource?: string });
    expect(frames(subscribed)).toContainEqual(
      expect.objectContaining({
        type: "resource.changed",
        resource: "command-catalog",
        workspaceName: null,
      }),
    );
    expect(frames(subscribed).some((frame) => frame.type === "protocol.error")).toBe(false);
    expect(frames(other).some((frame) => frame.type === "resource.changed")).toBe(false);
  } finally {
    subscribed.disconnect();
    other.disconnect();
  }
});
