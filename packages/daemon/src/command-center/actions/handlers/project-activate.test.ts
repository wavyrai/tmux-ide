import { describe, expect, it } from "bun:test";
import { projectActivateHandler } from "./project-activate.ts";
import type { RegisteredProject } from "../../../schemas/registry.ts";
import { setActivationBackend } from "../../../lib/active-projects.ts";

const fakeProject = (): RegisteredProject =>
  ({
    name: "demo",
    dir: "/tmp/demo",
    detected: { frameworks: [], packageManager: null },
    registeredAt: "2026-01-01T00:00:00Z",
  }) as RegisteredProject;

describe("projectActivateHandler", () => {
  it("activates a registered project", async () => {
    const activated: Array<{ name: string; orchestrate: boolean | undefined }> = [];
    const result = await projectActivateHandler(
      { name: "demo" },
      {
        getProject: fakeProject,
        activateProject: async (name, options) => {
          activated.push({ name, orchestrate: options?.orchestrate });
        },
      },
    );

    expect(result).toEqual({ active: true, projectName: "demo" });
    expect(activated).toEqual([{ name: "demo", orchestrate: false }]);
  });

  it("only opts into orchestration when explicitly requested", async () => {
    const activated: boolean[] = [];
    await projectActivateHandler(
      { name: "demo", orchestrate: true },
      {
        getProject: fakeProject,
        activateProject: async (_name, options) => {
          activated.push(options?.orchestrate ?? false);
        },
      },
    );

    expect(activated).toEqual([true]);
  });

  it("raises project_not_found for unknown projects", async () => {
    await expect(
      projectActivateHandler(
        { name: "ghost" },
        { getProject: () => null, activateProject: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("is idempotent when activation backend is idempotent", async () => {
    let calls = 0;
    setActivationBackend({
      activateProject: async () => {
        calls++;
      },
      deactivateProject: async () => {},
    });

    try {
      await projectActivateHandler({ name: "demo" }, { getProject: fakeProject });
      await projectActivateHandler({ name: "demo" }, { getProject: fakeProject });
    } finally {
      setActivationBackend(null);
    }

    expect(calls).toBe(1);
  });
});
