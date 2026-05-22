import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendEvent, queryEvents, readEvents, type OrchestratorEvent } from "./event-log.ts";
import { __resetEventLogSqliteForTests } from "./event-log-sqlite.ts";

const FIXTURE: OrchestratorEvent[] = [
  {
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "dispatch",
    taskId: "001",
    agent: "Agent 1",
    message: "Dispatched task 001 to Agent 1",
  },
  {
    timestamp: "2026-01-01T00:05:00.000Z",
    type: "completion",
    taskId: "001",
    agent: "Agent 1",
    message: "Task 001 completed",
  },
  {
    timestamp: "2026-01-02T00:00:00.000Z",
    type: "dispatch",
    taskId: "002",
    agent: "Agent 2",
    message: "Dispatched task 002 to Agent 2",
  },
  {
    timestamp: "2026-01-03T00:00:00.000Z",
    type: "stall",
    taskId: "002",
    agent: "Agent 2",
    message: "Stall detected on task 002",
  },
];

const BACKENDS = ["file", "sqlite"] as const;

for (const backend of BACKENDS) {
  describe(`event-log (${backend} backend)`, () => {
    let dir: string;
    let prevBackend: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), `tmux-ide-evlog-${backend}-`));
      prevBackend = process.env.TMUX_IDE_EVENT_LOG;
      if (backend === "sqlite") process.env.TMUX_IDE_EVENT_LOG = "sqlite";
      else delete process.env.TMUX_IDE_EVENT_LOG;
      for (const event of FIXTURE) appendEvent(dir, event);
    });

    afterEach(() => {
      __resetEventLogSqliteForTests();
      rmSync(dir, { recursive: true, force: true });
      if (prevBackend === undefined) delete process.env.TMUX_IDE_EVENT_LOG;
      else process.env.TMUX_IDE_EVENT_LOG = prevBackend;
    });

    it("appends events and reads them back in chronological order", () => {
      const events = readEvents(dir);
      expect(events.length).toBe(FIXTURE.length);
      expect(events.map((e) => e.type)).toEqual(["dispatch", "completion", "dispatch", "stall"]);
      expect(events[0]!.taskId).toBe("001");
      expect(events[3]!.taskId).toBe("002");
    });

    it("preserves arbitrary OrchestratorEvent fields", () => {
      appendEvent(dir, {
        timestamp: "2026-02-01T00:00:00.000Z",
        type: "error",
        message: "boom",
        extra: { ratio: 0.5, tags: ["a", "b"] },
      } as OrchestratorEvent);

      const events = readEvents(dir);
      const errored = events.find((e) => e.type === "error");
      expect(errored).toBeDefined();
      expect((errored as { extra?: unknown }).extra).toEqual({
        ratio: 0.5,
        tags: ["a", "b"],
      });
    });

    it("queryEvents filters by session", () => {
      const sessionName = basename(dir);
      const found = queryEvents(dir, { session: sessionName });
      expect(found.length).toBe(FIXTURE.length);

      const empty = queryEvents(dir, { session: "nonexistent-session" });
      expect(empty.length).toBe(0);
    });

    it("queryEvents filters by kind", () => {
      const dispatches = queryEvents(dir, { kind: "dispatch" });
      expect(dispatches.length).toBe(2);
      expect(dispatches.every((e) => e.type === "dispatch")).toBe(true);

      const stalls = queryEvents(dir, { kind: "stall" });
      expect(stalls.length).toBe(1);
      expect(stalls[0]!.taskId).toBe("002");
    });

    it("queryEvents filters by ts range", () => {
      const within = queryEvents(dir, {
        fromTs: "2026-01-01T00:01:00.000Z",
        toTs: "2026-01-02T23:59:59.000Z",
      });
      expect(within.length).toBe(2);
      expect(within[0]!.type).toBe("completion");
      expect(within[1]!.type).toBe("dispatch");
      expect(within[1]!.taskId).toBe("002");
    });

    it("queryEvents combines filters and respects limit", () => {
      const out = queryEvents(dir, {
        kind: "dispatch",
        fromTs: "2026-01-02T00:00:00.000Z",
      });
      expect(out.length).toBe(1);
      expect(out[0]!.taskId).toBe("002");

      const limited = queryEvents(dir, { limit: 2 });
      expect(limited.length).toBe(2);
    });
  });
}
