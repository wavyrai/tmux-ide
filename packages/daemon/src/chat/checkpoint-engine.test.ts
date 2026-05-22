import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCheckpointEngine, CheckpointEngineError } from "./checkpoint-engine.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Checkpoint Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Checkpoint Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout;
}

async function initRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-ckpt-"));
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Checkpoint Test");
  await git(root, "config", "commit.gpgsign", "false");
  return root;
}

async function commit(cwd: string, file: string, content: string, message: string): Promise<void> {
  writeFileSync(join(cwd, file), content);
  await git(cwd, "add", file);
  await git(cwd, "commit", "--quiet", "-m", message);
}

describe("checkpoint-engine — git integration", () => {
  let repo: string;
  const tracked: string[] = [];

  beforeEach(async () => {
    repo = await initRepo();
    tracked.push(repo);
    await commit(repo, "README.md", "hello\n", "initial");
    await commit(repo, "src.ts", "export const a = 1;\n", "feat: src");
  });

  afterEach(() => {
    for (const dir of tracked.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshot anchors a ref under refs/tmux-ide/checkpoints and reports changed files", async () => {
    writeFileSync(join(repo, "src.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "new.ts"), "export const b = 'b';\n");

    const engine = makeCheckpointEngine();
    const snap = await engine.snapshot({
      threadId: "thr-1",
      turnId: "turn-1",
      workspaceDir: repo,
    });

    expect(snap.refName).toBe("refs/tmux-ide/checkpoints/thr-1/turn-1");
    expect(snap.checkpointRef).toMatch(/^[0-9a-f]{40}$/);

    const refList = await git(repo, "for-each-ref", "refs/tmux-ide/checkpoints/");
    expect(refList).toContain("refs/tmux-ide/checkpoints/thr-1/turn-1");

    const byPath = new Map(snap.files.map((f) => [f.path, f]));
    expect(byPath.get("src.ts")).toEqual({
      path: "src.ts",
      kind: "modified",
      additions: 1,
      deletions: 1,
    });
    // `git stash create` captures index+worktree, so the untracked file
    // shows up in the snapshot once added. Even without `git add`, our
    // diff vs HEAD only lists tracked changes, so `new.ts` will appear
    // after staging — verify the engine handles staged-add as `added`.
    await git(repo, "add", "new.ts");
    const snap2 = await engine.snapshot({
      threadId: "thr-1",
      turnId: "turn-2",
      workspaceDir: repo,
    });
    const added = snap2.files.find((f) => f.path === "new.ts");
    expect(added?.kind).toBe("added");
    expect(added?.additions).toBe(1);
  });

  it("snapshot on a clean tree falls back to HEAD and yields zero files", async () => {
    const engine = makeCheckpointEngine();
    const snap = await engine.snapshot({
      threadId: "thr-2",
      turnId: "turn-clean",
      workspaceDir: repo,
    });

    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    expect(snap.checkpointRef).toBe(head);
    expect(snap.files).toEqual([]);
  });

  it("status returns 'ready' for live refs, 'missing' for unknown refs, 'error' outside a repo", async () => {
    const engine = makeCheckpointEngine();
    writeFileSync(join(repo, "src.ts"), "export const a = 2;\n");
    const snap = await engine.snapshot({
      threadId: "thr-3",
      turnId: "turn-1",
      workspaceDir: repo,
    });

    expect(await engine.status({ checkpointRef: snap.refName, workspaceDir: repo })).toBe("ready");

    expect(
      await engine.status({
        checkpointRef: "refs/tmux-ide/checkpoints/thr-3/does-not-exist",
        workspaceDir: repo,
      }),
    ).toBe("missing");

    const notARepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    tracked.push(notARepo);
    expect(await engine.status({ checkpointRef: snap.refName, workspaceDir: notARepo })).toBe(
      "error",
    );
  });

  it("revert restores tracked files to the snapshot, leaves untracked files alone", async () => {
    const engine = makeCheckpointEngine();
    writeFileSync(join(repo, "src.ts"), "export const a = 2;\n");
    const snap = await engine.snapshot({
      threadId: "thr-4",
      turnId: "turn-1",
      workspaceDir: repo,
    });

    // Commit the changes so the working tree is clean (no conflict with
    // revert) but HEAD has moved beyond the snapshot.
    await git(repo, "add", "src.ts");
    await git(repo, "commit", "--quiet", "-m", "advance");
    writeFileSync(join(repo, "src.ts"), "export const a = 99;\n");
    await git(repo, "add", "src.ts");
    await git(repo, "commit", "--quiet", "-m", "advance again");

    // Drop an untracked file — revert must not touch it.
    writeFileSync(join(repo, "scratch.txt"), "keep me\n");

    await engine.revert({ checkpointRef: snap.checkpointRef, workspaceDir: repo });

    expect(readFileSync(join(repo, "src.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("keep me\n");
  });

  it("revert refuses when uncommitted changes conflict with the snapshot", async () => {
    const engine = makeCheckpointEngine();
    writeFileSync(join(repo, "src.ts"), "export const a = 2;\n");
    const snap = await engine.snapshot({
      threadId: "thr-5",
      turnId: "turn-1",
      workspaceDir: repo,
    });
    // User keeps editing the same file AFTER the snapshot — reverting to
    // the snapshot would silently throw away their newer edits. The engine
    // must refuse so the caller can stash/commit first.
    writeFileSync(join(repo, "src.ts"), "export const a = 99;\n");

    await expect(
      engine.revert({ checkpointRef: snap.checkpointRef, workspaceDir: repo }),
    ).rejects.toMatchObject({ code: "dirty_conflict" });

    try {
      await engine.revert({ checkpointRef: snap.checkpointRef, workspaceDir: repo });
      throw new Error("expected revert to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CheckpointEngineError);
      expect((err as Error).message).toContain("src.ts");
    }

    // The conflicting file was not touched.
    expect(readFileSync(join(repo, "src.ts"), "utf8")).toBe("export const a = 99;\n");
  });

  it("revert errors when the checkpoint ref does not resolve", async () => {
    const engine = makeCheckpointEngine();
    await expect(
      engine.revert({
        checkpointRef: "refs/tmux-ide/checkpoints/thr-6/never-existed",
        workspaceDir: repo,
      }),
    ).rejects.toMatchObject({ code: "ref_not_found" });
  });

  it("listForThread enumerates refs for the given thread only", async () => {
    const engine = makeCheckpointEngine();
    writeFileSync(join(repo, "src.ts"), "export const a = 2;\n");
    const a = await engine.snapshot({
      threadId: "thr-7",
      turnId: "turn-1",
      workspaceDir: repo,
    });
    writeFileSync(join(repo, "src.ts"), "export const a = 3;\n");
    const b = await engine.snapshot({
      threadId: "thr-7",
      turnId: "turn-2",
      workspaceDir: repo,
    });
    writeFileSync(join(repo, "src.ts"), "export const a = 4;\n");
    await engine.snapshot({
      threadId: "other-thread",
      turnId: "turn-1",
      workspaceDir: repo,
    });

    const rows = await engine.listForThread({ threadId: "thr-7", workspaceDir: repo });
    const refNames = rows.map((r) => r.refName).sort();
    expect(refNames).toEqual([a.refName, b.refName].sort());
    for (const row of rows) {
      expect(row.checkpointRef).toMatch(/^[0-9a-f]{40}$/);
      expect(row.turnId).toMatch(/^turn-/);
    }
  });

  it("rejects unsafe thread/turn IDs to avoid ref injection", async () => {
    const engine = makeCheckpointEngine();
    await expect(
      engine.snapshot({
        threadId: "../escape",
        turnId: "ok",
        workspaceDir: repo,
      }),
    ).rejects.toMatchObject({ code: "invalid_id" });
    await expect(
      engine.snapshot({
        threadId: "ok",
        turnId: "with space",
        workspaceDir: repo,
      }),
    ).rejects.toMatchObject({ code: "invalid_id" });
  });
});

describe("checkpoint-engine — not a git repo", () => {
  it("snapshot fails clearly outside a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-no-repo-"));
    try {
      const engine = makeCheckpointEngine();
      await expect(
        engine.snapshot({ threadId: "t", turnId: "u", workspaceDir: dir }),
      ).rejects.toMatchObject({ code: "not_a_git_repo" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
