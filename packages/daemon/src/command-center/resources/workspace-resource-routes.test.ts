import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { createApp } from "../server.ts";

const OWNER = "owner-capability-secret";
const scratch: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdio: "pipe",
  });
}

function makeWorkspace(): { app: ReturnType<typeof createApp>; projectDir: string } {
  const registryDir = mkdtempSync(join(tmpdir(), "route-registry-"));
  const projectDir = mkdtempSync(join(tmpdir(), "route-project-"));
  scratch.push(registryDir, projectDir);

  git(projectDir, "init", "-q", "-b", "main");
  writeFileSync(join(projectDir, "readme.md"), "# hi\n");
  git(projectDir, "add", "readme.md");
  git(projectDir, "commit", "-qm", "init");
  writeFileSync(join(projectDir, "readme.md"), "# hi\nmore\n");

  const registry = new WorkspaceRegistry({ dir: registryDir, listSessions: () => [] });
  registry.add({
    name: "alpha",
    sessionName: "alpha",
    projectDir,
    configKind: "none",
    configPath: null,
    hasWorkspaceConfig: false,
  });

  const app = createApp({
    remoteAccess: {
      bindHostname: "127.0.0.1",
      token: null,
      localBypassToken: null,
      ownerToken: OWNER,
    },
    workspaceRegistry: registry,
  });
  return { app, projectDir };
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${OWNER}` };
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("workspace resource routes", () => {
  it("rejects a request without the owner bearer", async () => {
    const { app } = makeWorkspace();
    const res = await app.request("http://localhost/api/project/alpha/files");
    expect(res.status).toBe(401);
  });

  it("returns a stamped files catalog for the owner", async () => {
    const { app } = makeWorkspace();
    const res = await app.request("http://localhost/api/project/alpha/files", { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.daemon).toBeDefined();
    expect(body.resource.status).toBe("ready");
    expect(body.resource.entries.map((e: { name: string }) => e.name)).toContain("readme.md");
  });

  it("serves a bounded file preview via an issued id", async () => {
    const { app } = makeWorkspace();
    const listed = await (
      await app.request("http://localhost/api/project/alpha/files", { headers: auth() })
    ).json();
    const file = listed.resource.entries.find((e: { name: string }) => e.name === "readme.md");
    const res = await app.request(
      `http://localhost/api/project/alpha/file-preview?fileId=${encodeURIComponent(file.id)}`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource.status).toBe("ready");
    expect(body.resource.content).toContain("# hi");
  });

  it("requires a fileId for the preview route", async () => {
    const { app } = makeWorkspace();
    const res = await app.request("http://localhost/api/project/alpha/file-preview", {
      headers: auth(),
    });
    expect(res.status).toBe(400);
  });

  it("returns the changes catalog and a diff for a change", async () => {
    const { app } = makeWorkspace();
    const changes = await (
      await app.request("http://localhost/api/project/alpha/changes", { headers: auth() })
    ).json();
    expect(changes.resource.status).toBe("ready");
    const change = changes.resource.entries.find(
      (e: { relativePath: string }) => e.relativePath === "readme.md",
    );
    expect(change).toBeDefined();

    const diff = await (
      await app.request(
        `http://localhost/api/project/alpha/change-diff?changeId=${encodeURIComponent(change.id)}`,
        { headers: auth() },
      )
    ).json();
    expect(diff.resource.status).toBe("ready");
    expect(diff.resource.hunks.length).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown workspace", async () => {
    const { app } = makeWorkspace();
    const res = await app.request("http://localhost/api/project/missing/files", {
      headers: auth(),
    });
    expect(res.status).toBe(404);
  });
});
