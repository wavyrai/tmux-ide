import { describe, expect, it } from "vitest";
import { DaemonEventClientFrameSchemaZ, DaemonEventServerFrameSchemaZ } from "../daemon-events.ts";

describe("daemon event contracts", () => {
  it("accepts every client frame and rejects missing or extra fields", () => {
    expect(
      DaemonEventClientFrameSchemaZ.parse({ type: "subscribe", sessions: ["tmux-ide"] }),
    ).toEqual({ type: "subscribe", sessions: ["tmux-ide"] });
    expect(
      DaemonEventClientFrameSchemaZ.safeParse({ type: "unsubscribe", sessions: [] }).success,
    ).toBe(true);
    expect(DaemonEventClientFrameSchemaZ.safeParse({ type: "ping" }).success).toBe(true);

    expect(DaemonEventClientFrameSchemaZ.safeParse({ type: "subscribe" }).success).toBe(false);
    expect(
      DaemonEventClientFrameSchemaZ.safeParse({
        type: "subscribe",
        sessions: [],
        typo: true,
      }).success,
    ).toBe(false);
    expect(DaemonEventClientFrameSchemaZ.safeParse({ type: "ping", sessions: [] }).success).toBe(
      false,
    );
  });

  it("strictly parses snapshots and protocol errors", () => {
    const snapshot = {
      type: "snapshot",
      sessionName: "tmux-ide",
      data: {
        project: {
          session: "tmux-ide",
          dir: "/repo/tmux-ide",
          panes: [],
        },
      },
    } as const;
    expect(DaemonEventServerFrameSchemaZ.parse(snapshot)).toEqual(snapshot);
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...snapshot, unexpected: true }).success).toBe(
      false,
    );
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...snapshot,
        data: { project: { ...snapshot.data.project, unexpected: true } },
      }).success,
    ).toBe(false);

    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        type: "protocol.error",
        code: "invalid-frame",
        message: "Client frame does not match the daemon event protocol.",
      }).success,
    ).toBe(true);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        type: "protocol.error",
        code: "unknown",
        message: "nope",
      }).success,
    ).toBe(false);
  });

  it("keeps every historical server discriminator parseable", () => {
    const frames = [
      { type: "hello", sessions: [] },
      { type: "sessions.changed" },
      { type: "projects.changed" },
      { type: "init.output", jobId: "job-1", chunk: "working", done: false },
      { type: "init.error", jobId: "job-1", message: "failed" },
      { type: "pong" },
      { type: "action.complete", name: "project.launch", result: { ok: true } },
      { type: "config.changed", sessionName: "tmux-ide" },
      { type: "terminals.changed", sessionName: "tmux-ide" },
      {
        type: "workspace.added",
        workspace: {
          name: "tmux-ide",
          sessionName: "tmux-ide",
          projectDir: "/repo/tmux-ide",
          ideConfigPath: null,
          addedAt: "2026-07-21T12:00:00.000Z",
        },
      },
      { type: "workspace.removed", name: "tmux-ide" },
    ];

    for (const frame of frames) {
      expect(DaemonEventServerFrameSchemaZ.safeParse(frame).success, frame.type).toBe(true);
    }
  });
});
