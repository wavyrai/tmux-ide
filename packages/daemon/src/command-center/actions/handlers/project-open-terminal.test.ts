import { describe, it, expect } from "bun:test";
import type { Stats } from "node:fs";
import { defaultTerminalTabId, projectOpenTerminalHandler } from "./project-open-terminal.ts";
import { ActionError } from "../errors.ts";
import type { RegisteredProject } from "../../../schemas/registry.ts";

function fakeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    name: "wavyr-website",
    dir: "/tmp/wavyr-website",
    detected: { frameworks: [], packageManager: null },
    registeredAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as RegisteredProject;
}

const fakeStat =
  (isDirectory: boolean): ((cwd: string) => Stats) =>
  () =>
    ({ isDirectory: () => isDirectory }) as Stats;
const activateProject = async () => {};

describe("projectOpenTerminalHandler", () => {
  it("returns the terminal tab id and resolved cwd, launching when not running", async () => {
    let launched = 0;
    const result = await projectOpenTerminalHandler(
      { name: "wavyr-website" },
      {
        getProject: () => fakeProject(),
        hasSession: () => false,
        launch: async () => {
          launched++;
        },
        statCwd: fakeStat(true),
        activateProject,
      },
    );

    expect(launched).toBe(1);
    expect(result).toEqual({
      sessionName: "wavyr-website",
      cwd: "/tmp/wavyr-website",
      terminalTabId: "terminal:wavyr-website:default",
      launched: true,
    });
    expect(defaultTerminalTabId("wavyr-website")).toBe("terminal:wavyr-website:default");
  });

  it("does not relaunch when the session is already running", async () => {
    let launched = 0;
    const result = await projectOpenTerminalHandler(
      { name: "wavyr-website" },
      {
        getProject: () => fakeProject(),
        hasSession: () => true,
        launch: async () => {
          launched++;
        },
        statCwd: fakeStat(true),
        activateProject,
      },
    );

    expect(launched).toBe(0);
    expect(result.launched).toBe(false);
    expect(result.terminalTabId).toBe("terminal:wavyr-website:default");
  });

  it("raises project_not_found when the registry has no entry", async () => {
    await expect(
      projectOpenTerminalHandler(
        { name: "ghost" },
        {
          getProject: () => null,
          hasSession: () => false,
          launch: async () => {},
          activateProject,
        },
      ),
    ).rejects.toMatchObject({
      code: "project_not_found",
    });
  });

  it("raises cwd_not_found when the project dir is missing", async () => {
    const missing: (cwd: string) => Stats = () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    await expect(
      projectOpenTerminalHandler(
        { name: "wavyr-website" },
        {
          getProject: () => fakeProject(),
          hasSession: () => true,
          launch: async () => {},
          statCwd: missing,
          activateProject,
        },
      ),
    ).rejects.toMatchObject({ code: "cwd_not_found" });
  });

  it("raises cwd_not_directory when the path is a file", async () => {
    await expect(
      projectOpenTerminalHandler(
        { name: "wavyr-website" },
        {
          getProject: () => fakeProject(),
          hasSession: () => true,
          launch: async () => {},
          statCwd: fakeStat(false),
          activateProject,
        },
      ),
    ).rejects.toMatchObject({ code: "cwd_not_directory" });
  });

  it("raises launch_failed when launch throws", async () => {
    await expect(
      projectOpenTerminalHandler(
        { name: "wavyr-website" },
        {
          getProject: () => fakeProject(),
          hasSession: () => false,
          launch: async () => {
            throw new Error("tmux missing");
          },
          statCwd: fakeStat(true),
          activateProject,
        },
      ),
    ).rejects.toMatchObject({
      code: "launch_failed",
    });
  });

  it("returned errors are ActionError instances", async () => {
    let caught: unknown;
    try {
      await projectOpenTerminalHandler(
        { name: "ghost" },
        {
          getProject: () => null,
          hasSession: () => false,
          launch: async () => {},
          activateProject,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActionError);
  });

  it("activates the project before launching a terminal", async () => {
    const calls: string[] = [];
    const result = await projectOpenTerminalHandler(
      { name: "wavyr-website" },
      {
        getProject: () => fakeProject(),
        hasSession: () => true,
        launch: async () => {},
        statCwd: fakeStat(true),
        activateProject: async (name) => {
          calls.push(name);
        },
      },
    );

    expect(calls).toEqual(["wavyr-website"]);
    expect(result.launched).toBe(false);
  });

  it("surfaces activation failures", async () => {
    await expect(
      projectOpenTerminalHandler(
        { name: "wavyr-website" },
        {
          getProject: () => fakeProject(),
          hasSession: () => true,
          launch: async () => {},
          statCwd: fakeStat(true),
          activateProject: async () => {
            throw new Error("activation failed");
          },
        },
      ),
    ).rejects.toThrow(/activation failed/);
  });
});
