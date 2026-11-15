import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WorkspaceRegistry,
  _setDefaultWorkspaceRegistryForTests,
} from "../lib/workspace-registry.ts";
import { _setTmuxRunner } from "./discovery.ts";
import { createApp } from "./server.ts";

let dir: string;
let registry: WorkspaceRegistry;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-catalog-unavailable-"));
  registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
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

  // The legacy list the TUI reads (tool-resource-controller.ts) said "no
  // sessions" for a server it could not reach, too.
  describe("the legacy session list, /api/sessions", () => {
    let restore: (() => void) | null = null;
    afterEach(() => {
      restore?.();
      restore = null;
    });
    const failing = (stderr: string | null) =>
      _setTmuxRunner(() => {
        throw Object.assign(new Error("Command failed: tmux"), stderr === null ? {} : { stderr });
      });

    it.each([
      "error connecting to /tmp/t.sock (Permission denied)\n",
      "open terminal failed: not a terminal\n",
      null,
    ])("answers 503 when tmux cannot be asked: %s", async (stderr) => {
      restore = failing(stderr);
      const response = await createApp().request("/api/sessions");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Tmux session discovery is unavailable",
        code: "tmux-unavailable",
      });
    });

    it("lists no sessions when no server is running", async () => {
      restore = failing("no server running on /tmp/t.sock\n");
      const response = await createApp().request("/api/sessions");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [] });
    });

    it("lists the sessions tmux reports", async () => {
      registry.add({ name: "alpha", projectDir: "/tmp/alpha" });
      restore = _setTmuxRunner((args) => {
        if (args[0] === "list-sessions") return "alpha";
        if (args[0] === "display-message") return "/tmp/alpha";
        return "";
      });
      const response = await createApp().request("/api/sessions");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [{ name: "alpha", dir: "/tmp/alpha" }] });
    });
  });
});

// The legacy event stream diffed discoverSessions() every 2 s: an unreadable
// socket announced every running session as removed, and as added again once
// tmux answered (#753, review of 5f4c6694).
describe("the legacy event stream, /api/events, when tmux cannot be asked", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    vi.useRealTimers();
  });

  it("announces no removal and no return of sessions that kept running", async () => {
    vi.useFakeTimers();
    registry.add({ name: "alpha", projectDir: "/tmp/alpha" });
    let reachable = true;
    restore = _setTmuxRunner((args) => {
      if (!reachable)
        throw Object.assign(new Error("Command failed: tmux"), {
          stderr: "error connecting to /tmp/t.sock (Permission denied)\n",
        });
      if (args[0] === "list-sessions") return "alpha";
      if (args[0] === "display-message") return "/tmp/alpha";
      return "";
    });
    const response = await createApp().request("/api/events");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    void (async () => {
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (next.done) return;
        text += decoder.decode(next.value);
      }
    })();
    await vi.advanceTimersByTimeAsync(10);
    expect(text).toContain("event: session_added");
    text = "";
    reachable = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(text).not.toContain("session_removed");
    reachable = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(text).not.toContain("session_added");
    await reader.cancel();
  });
});
