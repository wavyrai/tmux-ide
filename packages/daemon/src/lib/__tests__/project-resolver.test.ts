import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProject,
  type ProjectResolverIo,
  type ResolveProjectOptions,
} from "../project-resolver.ts";

interface FakeIoOptions {
  files?: string[];
  realpaths?: Record<string, string>;
  runGit?: ProjectResolverIo["runGit"];
}

function fakeIo(options: FakeIoOptions = {}): ProjectResolverIo {
  const files = new Set(options.files ?? []);
  return {
    exists: (path) => files.has(path),
    realpath: (path) => options.realpaths?.[path] ?? path,
    runGit: options.runGit ?? (async () => null),
  };
}

function gitIo(topLevel: string, commonDir: string): ProjectResolverIo {
  return fakeIo({
    runGit: async (args) => {
      if (args.includes("--show-toplevel")) return topLevel;
      if (args.includes("--git-common-dir")) return commonDir;
      return null;
    },
  });
}

async function resolveWithIo(
  dir: string,
  io: ProjectResolverIo,
  options: Omit<ResolveProjectOptions, "io"> = {},
) {
  return resolveProject(dir, { ...options, io });
}

describe("resolveProject", () => {
  it("resolves a nested Git directory to its canonical working-tree root", async () => {
    const result = await resolveWithIo("/repo/apps/web", gitIo("/repo", ".git"));

    expect(result.inputDir).toBe("/repo/apps/web");
    expect(result.projectRoot).toBe("/repo");
    expect(result.identitySource).toBe("git-common-dir");
    expect(result.identityAnchor).toBe("/repo/.git");
    expect(result.identityKey).toMatch(/^git-[a-f0-9]{64}$/);
  });

  it("gives a linked worktree and main checkout one identity but separate roots", async () => {
    const main = await resolveWithIo("/repo", gitIo("/repo", ".git"));
    const linked = await resolveWithIo(
      "/worktrees/feature/src",
      gitIo("/worktrees/feature", "/repo/.git"),
    );

    expect(linked.projectRoot).not.toBe(main.projectRoot);
    expect(linked.identityKey).toBe(main.identityKey);
    expect(linked.identityAnchor).toBe(main.identityAnchor);
  });

  it("prefers the nearest workspace config over the nearest legacy config", async () => {
    const io = fakeIo({
      files: ["/repo/.tmux-ide/workspace.yml", "/repo/apps/api/ide.yml"],
    });
    const result = await resolveWithIo("/repo/apps/api/src", io);

    expect(result.config).toEqual({
      kind: "workspace",
      path: "/repo/.tmux-ide/workspace.yml",
      explicit: false,
    });
    expect(result.workspaceConfigPath).toBe("/repo/.tmux-ide/workspace.yml");
    expect(result.legacyConfigPath).toBe("/repo/apps/api/ide.yml");
    expect(result.projectRoot).toBe("/repo");
  });

  it("lets an explicit config path win over discovered files", async () => {
    const io = fakeIo({ files: ["/repo/.tmux-ide/workspace.yml", "/repo/ide.yml"] });
    const result = await resolveWithIo("/repo/apps/api", io, {
      explicitConfigPath: "../../config/custom.yml",
    });

    expect(result.config).toEqual({
      kind: "workspace",
      path: "/repo/config/custom.yml",
      explicit: true,
    });
    expect(result.projectRoot).toBe("/repo/config");
  });

  it("uses canonical config paths and a canonical-realpath identity outside Git", async () => {
    const io = fakeIo({
      files: ["/actual/project/ide.yml"],
      realpaths: {
        "/alias/project": "/actual/project",
        "/actual/project/ide.yml": "/actual/project/ide.yml",
      },
    });
    const result = await resolveWithIo("/alias/project", io);

    expect(result.inputDir).toBe("/actual/project");
    expect(result.projectRoot).toBe("/actual/project");
    expect(result.identitySource).toBe("canonical-realpath");
    expect(result.identityAnchor).toBe("/actual/project");
    expect(result.identityKey).toMatch(/^path-[a-f0-9]{64}$/);
    expect(result.config.kind).toBe("legacy");
  });

  it("falls back to the canonical input directory for a config-free non-Git project", async () => {
    const io = fakeIo({ realpaths: { "/alias/project": "/actual/project" } });
    const result = await resolveWithIo("/alias/project", io);

    expect(result.projectRoot).toBe("/actual/project");
    expect(result.config).toEqual({ kind: "none", path: null, explicit: false });
  });

  it("handles unavailable Git and malformed output safely and deterministically", async () => {
    const unavailable = fakeIo({
      runGit: async () => {
        throw new Error("ENOENT");
      },
    });
    const malformed = fakeIo({
      runGit: async (args) => (args.includes("--show-toplevel") ? "/repo\n/untrusted" : null),
    });

    const unavailableResult = await resolveWithIo("/repo/app", unavailable);
    const malformedA = await resolveWithIo("/repo/app", malformed);
    const malformedB = await resolveWithIo("/repo/app", malformed);

    expect(unavailableResult.identitySource).toBe("canonical-realpath");
    expect(unavailableResult.projectRoot).toBe("/repo/app");
    expect(malformedA.identitySource).toBe("canonical-realpath");
    expect(malformedA.identityKey).toBe(malformedB.identityKey);
  });

  it("shares identity across real temporary Git worktrees", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "tmux-ide-resolver-"));
    const main = join(tempRoot, "main");
    const linked = join(tempRoot, "linked");

    try {
      mkdirSync(main);
      execFileSync("git", ["init", "--quiet", main]);
      execFileSync("git", [
        "-C",
        main,
        "-c",
        "user.name=tmux-ide-test",
        "-c",
        "user.email=test@tmux-ide.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "init",
      ]);
      execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "-b", "linked", linked]);

      const mainResult = await resolveProject(main);
      const linkedResult = await resolveProject(linked);

      expect(mainResult.projectRoot).toBe(realpathSync(main));
      expect(linkedResult.projectRoot).toBe(realpathSync(linked));
      expect(linkedResult.identitySource).toBe("git-common-dir");
      expect(linkedResult.identityKey).toBe(mainResult.identityKey);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
