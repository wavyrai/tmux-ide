import { describe, it, expect } from "bun:test";
import { projectRestartHandler } from "./project-restart.ts";
import type { RegisteredProject } from "../../../schemas/registry.ts";

const fakeProject = (): RegisteredProject =>
  ({
    name: "demo",
    dir: "/tmp/demo",
    detected: { frameworks: [], packageManager: null },
    registeredAt: "2026-01-01T00:00:00Z",
  }) as RegisteredProject;

describe("projectRestartHandler", () => {
  it("calls restart with attach: false and reports success", async () => {
    const calls: Array<{ dir: string; attach: boolean | undefined }> = [];
    const result = await projectRestartHandler(
      { name: "demo" },
      {
        getProject: fakeProject,
        restart: async (dir, opts) => {
          calls.push({ dir, attach: opts.attach });
        },
      },
    );
    expect(calls).toEqual([{ dir: "/tmp/demo", attach: false }]);
    expect(result).toEqual({ sessionName: "demo", restarted: true });
  });

  it("raises project_not_found for unknown projects", async () => {
    await expect(
      projectRestartHandler({ name: "ghost" }, { getProject: () => null, restart: async () => {} }),
    ).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("raises launch_failed when restart throws", async () => {
    await expect(
      projectRestartHandler(
        { name: "demo" },
        {
          getProject: fakeProject,
          restart: async () => {
            throw new Error("kaboom");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "launch_failed" });
  });
});
