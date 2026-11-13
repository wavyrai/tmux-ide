import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WorkspaceRegistry,
  _setDefaultWorkspaceRegistryForTests,
} from "../lib/workspace-registry.ts";
import { createApp } from "./server.ts";

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-catalog-unavailable-"));
  const registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
  await registry.load();
  _setDefaultWorkspaceRegistryForTests(registry);
});
afterEach(() => {
  _setDefaultWorkspaceRegistryForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("workspace catalog when tmux cannot be asked (#753)", () => {
  it.each(["2", "3"])("version %s answers 503, not an empty session list", async (version) => {
    const app = createApp({ catalogLiveSessions: () => null });
    const response = await app.request(`/api/resources/workspace-catalog?version=${version}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Tmux session discovery is unavailable",
      code: "tmux-unavailable",
    });
  });

  it.each(["2", "3"])("version %s still lists a server with no sessions", async (version) => {
    const app = createApp({ catalogLiveSessions: () => [] });
    const response = await app.request(`/api/resources/workspace-catalog?version=${version}`);
    expect(response.status).toBe(200);
    expect((await response.json()).liveSessions).toEqual([]);
  });
});
