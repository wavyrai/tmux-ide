import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WorkspaceRegistry,
  _setDefaultWorkspaceRegistryForTests,
} from "../lib/workspace-registry.ts";
import { _setTmuxRunner } from "./discovery.ts";
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

  // A host that injects no catalog reads tmux through discovery's own client.
  describe("without an injected catalog", () => {
    let restore: (() => void) | null = null;
    afterEach(() => {
      restore?.();
      restore = null;
    });
    const failing = (stderr: string) =>
      _setTmuxRunner(() => {
        throw Object.assign(new Error("Command failed: tmux"), { stderr });
      });

    it("answers 503 when tmux cannot be asked", async () => {
      restore = failing("error connecting to /tmp/t.sock (Permission denied)\n");
      const response = await createApp().request("/api/resources/workspace-catalog?version=3");
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("tmux-unavailable");
    });

    it("lists no sessions when no server is running", async () => {
      restore = failing("no server running on /tmp/t.sock\n");
      const response = await createApp().request("/api/resources/workspace-catalog?version=3");
      expect(response.status).toBe(200);
      expect((await response.json()).liveSessions).toEqual([]);
    });
  });
});
