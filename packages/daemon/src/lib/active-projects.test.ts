import { afterEach, describe, expect, it } from "bun:test";
import {
  activateProject,
  deactivateProject,
  isProjectActive,
  listActiveProjects,
  setActivationBackend,
} from "./active-projects.ts";

afterEach(() => {
  setActivationBackend(null);
});

describe("active-projects", () => {
  it("activates through the registered backend once", async () => {
    const activated: string[] = [];
    setActivationBackend({
      activateProject: async (name) => {
        activated.push(name);
      },
      deactivateProject: async () => {},
    });

    await activateProject("alpha");
    await activateProject("alpha");

    expect(activated).toEqual(["alpha"]);
    expect(isProjectActive("alpha")).toBe(true);
    expect(listActiveProjects()).toEqual(["alpha"]);
  });

  it("allows an active project to opt into orchestration later", async () => {
    const orchestrated: boolean[] = [];
    setActivationBackend({
      activateProject: async (_name, options) => {
        orchestrated.push(options?.orchestrate ?? false);
      },
      deactivateProject: async () => {},
    });

    await activateProject("alpha");
    await activateProject("alpha", { orchestrate: true });

    expect(orchestrated).toEqual([false, true]);
  });

  it("deactivates through the registered backend", async () => {
    const deactivated: string[] = [];
    setActivationBackend({
      activateProject: async () => {},
      deactivateProject: async (name) => {
        deactivated.push(name);
      },
    });

    await activateProject("alpha");
    await deactivateProject("alpha");

    expect(deactivated).toEqual(["alpha"]);
    expect(isProjectActive("alpha")).toBe(false);
  });

  it("errors when no backend is registered", async () => {
    await expect(activateProject("alpha")).rejects.toThrow(/No active-project backend/);
  });
});
