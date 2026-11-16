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

/**
 * #753 follow-up: the /api/project/:name routes found their session in
 * discoverSessions(), which is empty when tmux cannot be asked. They then
 * answered 404 "Session not found" for a session that was still running.
 */
let dir: string;
let restore: (() => void) | null = null;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-project-unavailable-"));
  const registry = new WorkspaceRegistry({ dir, listSessions: () => [] });
  await registry.load();
  registry.add({ name: "alpha", projectDir: dir });
  _setDefaultWorkspaceRegistryForTests(registry);
});
afterEach(() => {
  restore?.();
  restore = null;
  _setDefaultWorkspaceRegistryForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const failing = (stderr: string) =>
  _setTmuxRunner(() => {
    throw Object.assign(new Error("Command failed: tmux"), { stderr });
  });

const routes: [method: string, path: string, body?: unknown][] = [
  ["GET", "/api/project/alpha"],
  ["GET", "/api/project/alpha/panes"],
  ["GET", "/api/project/alpha/terminals"],
  ["GET", "/api/project/alpha/events"],
  ["GET", "/api/project/alpha/stream"],
  ["GET", "/api/project/alpha/config"],
  ["GET", "/api/project/alpha/application-shell?version=1"],
  ["POST", "/api/project/alpha/terminals", { scopeId: "s", name: "t" }],
  ["POST", "/api/project/alpha/terminals/t1/rename", { name: "u" }],
  ["DELETE", "/api/project/alpha/terminals/t1"],
  ["POST", "/api/project/alpha/inject", { text: "x" }],
  ["POST", "/api/project/alpha/send", { target: "a", message: "x" }],
  ["POST", "/api/project/alpha/config", {}],
  ["POST", "/api/project/alpha/restart"],
  ["POST", "/api/project/alpha/launch"],
  ["POST", "/api/project/alpha/stop"],
];

function request(method: string, path: string, body?: unknown) {
  return createApp().request(path, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

describe("project routes when tmux cannot be asked (#753)", () => {
  it.each(routes)("%s %s answers 503, not 404", async (method, path, body) => {
    restore = failing("error connecting to /tmp/t.sock (Permission denied)\n");
    const response = await request(method, path, body);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Tmux session discovery is unavailable",
      code: "tmux-unavailable",
    });
  });

  it.each(routes)("%s %s still answers 404 when no server runs", async (method, path, body) => {
    restore = failing("no server running on /tmp/t.sock\n");
    const response = await request(method, path, body);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it.each(["/api/project/alpha", "/api/project/alpha/events"])(
    "GET %s still finds a session tmux reports",
    async (path) => {
      restore = _setTmuxRunner((args) => {
        if (args[0] === "list-sessions") return "alpha";
        if (args[0] === "display-message") return dir;
        return "";
      });
      const response = await request("GET", path);
      expect(response.status).toBe(200);
    },
  );
});
