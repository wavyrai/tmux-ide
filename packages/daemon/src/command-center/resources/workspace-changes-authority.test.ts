import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WorkspaceChangeDiffResourceV1SchemaZ,
  WorkspaceChangesCatalogResourceV1SchemaZ,
} from "@tmux-ide/contracts";

import { ChangesAuthority, confineToWorkspace } from "./workspace-changes-authority.ts";

// Each catalog/diff case initializes a real git repo and runs several git
// subprocesses. On a machine saturated by parallel test workers those spawns
// are starved well past the 5s default, so give the whole file a generous
// wall-clock budget — the assertions themselves are unchanged.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "changes-authority-"));
  scratch.push(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("confineToWorkspace", () => {
  it("keeps paths inside the workspace and rejects escapes", () => {
    expect(confineToWorkspace("/repo/app", "/repo", "app/src/a.ts")).toBe("src/a.ts");
    expect(confineToWorkspace("/repo/app", "/repo", "other/b.ts")).toBeNull();
    expect(confineToWorkspace("/repo", "/repo", "a.ts")).toBe("a.ts");
    expect(confineToWorkspace("/repo", "/repo", "")).toBeNull();
  });
});

describe("ChangesAuthority.catalog", () => {
  it("reports not-a-git-repository outside a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    scratch.push(dir);
    const result = new ChangesAuthority(dir, "alpha").catalog();
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toBe("not-a-git-repository");
  });

  it("groups staged, unstaged, and untracked changes with the branch", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "init");

    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "staged.txt"), "new\n");
    git(repo, "add", "staged.txt");
    writeFileSync(join(repo, "untracked.txt"), "u\n");

    const catalog = WorkspaceChangesCatalogResourceV1SchemaZ.parse(
      new ChangesAuthority(repo, "alpha").catalog(),
    );
    expect(catalog.status).toBe("ready");
    if (catalog.status !== "ready") throw new Error("unreachable");
    expect(catalog.branch).toBe("main");
    expect(catalog.detached).toBe(false);

    const byPath = new Map(catalog.entries.map((e) => [`${e.group}:${e.relativePath}`, e]));
    expect(byPath.get("staged:staged.txt")?.status).toBe("added");
    expect(byPath.get("unstaged:tracked.txt")?.status).toBe("modified");
    expect(byPath.get("untracked:untracked.txt")?.status).toBe("untracked");
    expect(byPath.get("unstaged:tracked.txt")?.additions).toBe(1);
  });

  it("counts working-tree changes cheaply and reports null outside a repo", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "staged.txt"), "new\n");
    git(repo, "add", "staged.txt");
    writeFileSync(join(repo, "untracked.txt"), "u\n");

    expect(new ChangesAuthority(repo, "alpha").changeCount()).toBe(3);
    const notRepo = mkdtempSync(join(tmpdir(), "not-a-repo-count-"));
    scratch.push(notRepo);
    expect(new ChangesAuthority(notRepo, "alpha").changeCount()).toBeNull();
  });

  it("detects a staged rename with its origin path", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "old.txt"), "stable content here\n");
    git(repo, "add", "old.txt");
    git(repo, "commit", "-qm", "init");
    git(repo, "mv", "old.txt", "new.txt");

    const catalog = new ChangesAuthority(repo, "alpha").catalog();
    if (catalog.status !== "ready") throw new Error("unreachable");
    const rename = catalog.entries.find((e) => e.status === "renamed");
    expect(rename).toBeDefined();
    expect(rename!.relativePath).toBe("new.txt");
    expect(rename!.originPath).toBe("old.txt");
  });

  it("reports a detached HEAD with a null branch", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "init");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    git(repo, "checkout", "-q", head);

    const catalog = new ChangesAuthority(repo, "alpha").catalog();
    if (catalog.status !== "ready") throw new Error("unreachable");
    expect(catalog.detached).toBe(true);
    expect(catalog.branch).toBeNull();
  });

  it("only surfaces changes inside a workspace subdirectory of the repo", () => {
    const repo = initRepo();
    mkdirSync(join(repo, "app"));
    writeFileSync(join(repo, "app", "inside.txt"), "a\n");
    writeFileSync(join(repo, "outside.txt"), "b\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "app", "inside.txt"), "a\nchanged\n");
    writeFileSync(join(repo, "outside.txt"), "b\nchanged\n");

    const catalog = new ChangesAuthority(join(repo, "app"), "alpha").catalog();
    if (catalog.status !== "ready") throw new Error("unreachable");
    const paths = catalog.entries.map((e) => e.relativePath);
    expect(paths).toContain("inside.txt");
    expect(paths).not.toContain("outside.txt");
    expect(paths.some((p) => p.startsWith(".."))).toBe(false);
  });
});

describe("ChangesAuthority.diff", () => {
  it("produces a structured diff for a modified file", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "f.txt"), "one\ntwo\nthree\n");
    git(repo, "add", "f.txt");
    git(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "f.txt"), "one\ntwo changed\nthree\n");

    const authority = new ChangesAuthority(repo, "alpha");
    const catalog = authority.catalog();
    if (catalog.status !== "ready") throw new Error("unreachable");
    const change = catalog.entries.find((e) => e.relativePath === "f.txt")!;

    const diff = WorkspaceChangeDiffResourceV1SchemaZ.parse(authority.diff(change.id));
    expect(diff.status).toBe("ready");
    if (diff.status !== "ready") throw new Error("unreachable");
    expect(diff.hunks).toHaveLength(1);
    const kinds = diff.hunks[0]!.lines.map((l) => l.kind);
    expect(kinds).toContain("delete");
    expect(kinds).toContain("insert");
  });

  it("synthesizes an all-insert diff for an untracked file", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "seed.txt");
    git(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "fresh.txt"), "l1\nl2\nl3\n");

    const authority = new ChangesAuthority(repo, "alpha");
    const catalog = authority.catalog();
    if (catalog.status !== "ready") throw new Error("unreachable");
    const change = catalog.entries.find((e) => e.relativePath === "fresh.txt")!;
    const diff = authority.diff(change.id);
    if (diff.status !== "ready") throw new Error("unreachable");
    expect(diff.hunks[0]!.lines.every((l) => l.kind === "insert")).toBe(true);
    expect(diff.hunks[0]!.lines).toHaveLength(3);
  });

  it("classifies a binary change", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "b.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    git(repo, "add", "b.bin");
    git(repo, "commit", "-qm", "init");
    writeFileSync(join(repo, "b.bin"), Buffer.from([0x00, 0x09, 0x08, 0x07, 0x06]));

    const authority = new ChangesAuthority(repo, "alpha");
    const catalog = authority.catalog();
    if (catalog.status !== "ready") throw new Error("unreachable");
    const change = catalog.entries.find((e) => e.relativePath === "b.bin")!;
    expect(change.binary).toBe(true);
    expect(change.additions).toBeNull();
    const diff = authority.diff(change.id);
    expect(diff.status).toBe("binary");
  });

  it("returns change-not-found for an unknown change id", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "init");
    const diff = new ChangesAuthority(repo, "alpha").diff("change.aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(diff.status).toBe("unavailable");
    if (diff.status !== "unavailable") throw new Error("unreachable");
    expect(diff.reason).toBe("change-not-found");
  });
});
