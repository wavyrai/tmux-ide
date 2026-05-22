import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProject, InspectDirNotFoundError } from "./project-inspect.ts";

describe("inspectProject", () => {
  it("throws InspectDirNotFoundError when the directory does not exist", async () => {
    await expect(inspectProject("/does/not/exist")).rejects.toBeInstanceOf(InspectDirNotFoundError);
  });

  it("reports hasIdeYml=true when ide.yml is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-inspect-"));
    try {
      writeFileSync(join(dir, "ide.yml"), "name: x\nrows: []\n");
      const inspect = await inspectProject(dir);
      expect(inspect.hasIdeYml).toBe(true);
      expect(inspect.dir).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports hasIdeYml=false when ide.yml is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-inspect-"));
    try {
      const inspect = await inspectProject(dir);
      expect(inspect.hasIdeYml).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects pnpm + next from a JS project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-inspect-"));
    try {
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 6.0\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          dependencies: { next: "^14" },
          scripts: { dev: "next dev", test: "vitest" },
        }),
      );
      const inspect = await inspectProject(dir);
      expect(inspect.detected.packageManager).toBe("pnpm");
      expect(inspect.detected.frameworks).toContain("next");
      expect(inspect.detected.devCommand).toBe("pnpm dev");
      expect(inspect.detected.testCommand).toBe("pnpm test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null testCommand when no package manager is detected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-inspect-"));
    try {
      const inspect = await inspectProject(dir);
      expect(inspect.detected.packageManager).toBeNull();
      expect(inspect.detected.testCommand).toBeNull();
      expect(inspect.detected.devCommand).toBeNull();
      expect(inspect.detected.frameworks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses 'npm test' (not 'npm test') correctly when npm lockfile is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-inspect-"));
    try {
      writeFileSync(join(dir, "package-lock.json"), "{}");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { dev: "echo hi" } }),
      );
      const inspect = await inspectProject(dir);
      expect(inspect.detected.packageManager).toBe("npm");
      expect(inspect.detected.devCommand).toBe("npm run dev");
      expect(inspect.detected.testCommand).toBe("npm test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
