import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopWindowStateStore,
  parseDesktopWindowBounds,
  restoreDesktopWindowBounds,
} from "./window-state-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("desktop window state", () => {
  it("strictly validates useful integer bounds", () => {
    expect(parseDesktopWindowBounds({ x: 1, y: 2, width: 900, height: 600 })).toEqual({
      x: 1,
      y: 2,
      width: 900,
      height: 600,
    });
    expect(parseDesktopWindowBounds({ x: 1, y: 2, width: 10, height: 600 })).toBeNull();
    expect(parseDesktopWindowBounds({ x: 1.5, y: 2, width: 900, height: 600 })).toBeNull();
  });

  it("recenters offscreen persisted bounds", () => {
    expect(
      restoreDesktopWindowBounds({ x: 9_000, y: 9_000, width: 900, height: 600 }, [
        { x: 0, y: 0, width: 1440, height: 900 },
      ]),
    ).toEqual({ x: 80, y: 40, width: 1280, height: 820 });
  });

  it("round-trips valid state and ignores corrupt files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmux-ide-window-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state", "window.json");
    const store = new DesktopWindowStateStore(path);

    await store.write({ x: 20, y: 30, width: 1000, height: 700 });
    expect(await store.read()).toEqual({ x: 20, y: 30, width: 1000, height: 700 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      x: 20,
      y: 30,
      width: 1000,
      height: 700,
    });

    await writeFile(path, "not-json");
    await expect(store.read()).resolves.toBeNull();
  });
});
