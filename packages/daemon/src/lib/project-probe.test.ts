import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeProject, sanitizeName, type ProbeIo } from "./project-probe.ts";

function makeIo(overrides: Partial<ProbeIo> = {}): ProbeIo {
  return {
    exists: () => false,
    runGit: async () => null,
    ...overrides,
  };
}

describe("sanitizeName", () => {
  it("replaces spaces with hyphens", () => {
    expect(sanitizeName("my project")).toBe("my-project");
  });

  it("strips disallowed characters", () => {
    expect(sanitizeName("foo/bar:baz!")).toBe("foobarbaz");
  });

  it("trims leading/trailing hyphens", () => {
    expect(sanitizeName("---weird---")).toBe("weird");
  });

  it("preserves dots, underscores, and digits", () => {
    expect(sanitizeName("v1.2_alpha")).toBe("v1.2_alpha");
  });
});

describe("probeProject", () => {
  it("derives name from basename and falls back to 'project' if sanitization empties it", async () => {
    const probe = await probeProject("/tmp/!!!", makeIo());
    expect(probe.name).toBe("project");
  });

  it("reports hasIdeYml=true when ide.yml exists", async () => {
    const probe = await probeProject(
      "/work/foo",
      makeIo({ exists: (p) => p === "/work/foo/ide.yml" }),
    );
    expect(probe.hasIdeYml).toBe(true);
  });

  it("reports hasIdeYml=false when ide.yml is absent", async () => {
    const probe = await probeProject("/work/foo", makeIo({ exists: () => false }));
    expect(probe.hasIdeYml).toBe(false);
  });

  it("preserves hasIdeYml semantics for the input directory while using discovery", async () => {
    const probe = await probeProject(
      "/work/foo/nested",
      makeIo({ exists: (path) => path === "/work/foo/ide.yml" }),
    );
    expect(probe.hasIdeYml).toBe(false);
  });

  it("captures git origin + branch when both git calls succeed", async () => {
    const probe = await probeProject(
      "/work/foo",
      makeIo({
        runGit: async (args) => {
          if (args.includes("--get") && args.includes("remote.origin.url")) {
            return "git@github.com:wavyrai/tmux-ide.git";
          }
          if (args.includes("--show-current")) return "main";
          return null;
        },
      }),
    );
    expect(probe.gitOrigin).toBe("git@github.com:wavyrai/tmux-ide.git");
    expect(probe.gitBranch).toBe("main");
  });

  it("returns nulls for git fields when not a git repo", async () => {
    const probe = await probeProject("/work/foo", makeIo({ runGit: async () => null }));
    expect(probe.gitOrigin).toBeNull();
    expect(probe.gitBranch).toBeNull();
  });

  it("treats empty git output as null (detached HEAD case)", async () => {
    const probe = await probeProject("/work/foo", makeIo({ runGit: async () => "" }));
    expect(probe.gitOrigin).toBeNull();
    expect(probe.gitBranch).toBeNull();
  });

  it("works against a real directory with ide.yml on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-probe-"));
    try {
      writeFileSync(join(dir, "ide.yml"), "name: test\n");
      const probe = await probeProject(dir, {
        exists: (p) => p === join(dir, "ide.yml"),
        runGit: async () => null,
      });
      expect(probe.hasIdeYml).toBe(true);
      expect(probe.dir).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves relative paths to absolute", async () => {
    const probe = await probeProject(".", makeIo());
    expect(probe.dir.startsWith("/")).toBe(true);
  });
});
