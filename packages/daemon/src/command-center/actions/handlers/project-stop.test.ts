import { describe, it, expect } from "bun:test";
import { projectStopHandler } from "./project-stop.ts";
import type { RegisteredProject } from "../../../schemas/registry.ts";

const fakeProject = (): RegisteredProject =>
  ({
    name: "demo",
    dir: "/tmp/demo",
    detected: { frameworks: [], packageManager: null },
    registeredAt: "2026-01-01T00:00:00Z",
  }) as RegisteredProject;

describe("projectStopHandler", () => {
  it("kills the session, stops monitor, sweeps daemons", async () => {
    const seen = {
      monitor: 0,
      orphans: 0,
      kill: 0,
    };
    const result = await projectStopHandler(
      { name: "demo" },
      {
        getProject: fakeProject,
        hasSession: () => true,
        stopSessionMonitor: () => {
          seen.monitor++;
        },
        killOrphanDaemons: () => {
          seen.orphans++;
        },
        killSession: () => {
          seen.kill++;
          return { stopped: true, reason: null };
        },
      },
    );
    expect(seen).toEqual({ monitor: 1, orphans: 1, kill: 1 });
    expect(result).toEqual({ sessionName: "demo", stopped: true });
  });

  it("is idempotent when no session is running", async () => {
    let kills = 0;
    const result = await projectStopHandler(
      { name: "demo" },
      {
        getProject: fakeProject,
        hasSession: () => false,
        stopSessionMonitor: () => {
          throw new Error("should not be called");
        },
        killSession: () => {
          kills++;
          return { stopped: true, reason: null };
        },
        killOrphanDaemons: () => {
          throw new Error("should not be called");
        },
      },
    );
    expect(kills).toBe(0);
    expect(result).toEqual({ sessionName: "demo", stopped: false });
  });

  it("raises project_not_found for unknown projects", async () => {
    await expect(
      projectStopHandler({ name: "ghost" }, { getProject: () => null, hasSession: () => false }),
    ).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("raises stop_failed when killSession throws", async () => {
    await expect(
      projectStopHandler(
        { name: "demo" },
        {
          getProject: fakeProject,
          hasSession: () => true,
          stopSessionMonitor: () => {},
          killOrphanDaemons: () => {},
          killSession: () => {
            throw new Error("tmux is gone");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "stop_failed" });
  });
});
