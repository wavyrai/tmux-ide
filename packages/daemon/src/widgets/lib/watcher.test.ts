import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { watchDirectory } from "./watcher.ts";

describe("watchDirectory installation verdict", () => {
  it("rejects a missing directory when an authority requires an installed watcher", async () => {
    const missing = join(
      tmpdir(),
      `tmux-ide-missing-watch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await expect(
      watchDirectory(missing, () => undefined, { requireInstalled: true }),
    ).rejects.toBeDefined();
  });
});
