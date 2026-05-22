import { describe, it, expect } from "bun:test";
import { projectLaunchHandler } from "./project-launch.ts";
import type { RegisteredProject } from "../../../schemas/registry.ts";

const fakeProject = (): RegisteredProject =>
  ({
    name: "demo",
    dir: "/tmp/demo",
    detected: { frameworks: [], packageManager: null },
    registeredAt: "2026-01-01T00:00:00Z",
  }) as RegisteredProject;

describe("projectLaunchHandler", () => {
  it("launches when no session is running", async () => {
    const calls: Array<{ dir: string; attach: boolean }> = [];
    const result = await projectLaunchHandler(
      { name: "demo" },
      {
        getProject: fakeProject,
        hasSession: () => false,
        launch: async (dir, opts) => {
          calls.push({ dir, attach: opts.attach });
        },
      },
    );
    expect(calls).toEqual([{ dir: "/tmp/demo", attach: false }]);
    expect(result).toEqual({ sessionName: "demo", started: true });
  });

  it("is idempotent when the session is already running", async () => {
    let launched = 0;
    const result = await projectLaunchHandler(
      { name: "demo" },
      {
        getProject: fakeProject,
        hasSession: () => true,
        launch: async () => {
          launched++;
        },
      },
    );
    expect(launched).toBe(0);
    expect(result).toEqual({ sessionName: "demo", started: false });
  });

  it("raises project_not_found for unknown projects", async () => {
    await expect(
      projectLaunchHandler(
        { name: "ghost" },
        { getProject: () => null, hasSession: () => false, launch: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("raises launch_failed when launch throws", async () => {
    await expect(
      projectLaunchHandler(
        { name: "demo" },
        {
          getProject: fakeProject,
          hasSession: () => false,
          launch: async () => {
            throw new Error("boom");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "launch_failed" });
  });
});
