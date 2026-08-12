import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PICKER_OPEN_ID } from "../../folder-picker.ts";
import { runOpenFolderFlow } from "./feature.tsx";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tmux-ide-home-feature-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("deferred Home folder flow", () => {
  it("preserves cancellation without opening or mutating a project", async () => {
    const opened: string[] = [];
    await runOpenFolderFlow({
      start: await temporaryDirectory(),
      dialogs: {
        select: async () => null,
        prompt: async () => null,
        confirm: async () => false,
      },
      openFolder: (directory) => opened.push(directory),
      setStatusNote: () => undefined,
      refreshFleet: () => undefined,
      writeDetectedLayout: () => undefined,
    });
    expect(opened).toEqual([]);
  });

  it("opens the folder and preserves the registration failure state", async () => {
    const directory = await temporaryDirectory();
    const opened: string[] = [];
    const notes: string[] = [];
    let refreshed = 0;
    await runOpenFolderFlow({
      start: directory,
      dialogs: {
        select: async () => ({ item: { id: PICKER_OPEN_ID } }),
        prompt: async () => null,
        confirm: async () => true,
      },
      openFolder: (selected) => opened.push(selected),
      setStatusNote: (message) => notes.push(message),
      refreshFleet: () => {
        refreshed += 1;
      },
      writeDetectedLayout: () => undefined,
      register: async () => {
        throw new Error("registry unavailable");
      },
      hasProjectConfig: async () => true,
    });
    expect(opened).toEqual([directory]);
    expect(notes).toEqual(["couldn't remember that project"]);
    expect(refreshed).toBe(0);
  });
});
