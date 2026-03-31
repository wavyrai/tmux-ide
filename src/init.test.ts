import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.ts";

let tmpDir;
let origCwd;
let origLog;
let logged;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-init-test-"));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  logged = [];
  origLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
});

afterEach(() => {
  process.chdir(origCwd);
  console.log = origLog;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("init", () => {
  it("creates ide.yml from default template when no stack detected", async () => {
    await init({ json: true });
    expect(existsSync(join(tmpDir, "ide.yml"))).toBeTruthy();
    const output = JSON.parse(logged[0]);
    expect(output.created).toBe(true);
    expect(output.template).toBe("default");
  });

  it("creates ide.yml from named template", async () => {
    await init({ template: "nextjs", json: true });
    expect(existsSync(join(tmpDir, "ide.yml"))).toBeTruthy();
    const content = readFileSync(join(tmpDir, "ide.yml"), "utf-8");
    expect(content.includes("rows")).toBeTruthy();
    const output = JSON.parse(logged[0]);
    expect(output.created).toBe(true);
    expect(output.template).toBe("nextjs");
  });

  it("creates ide.yml from detected stack", async () => {
    // Create a package.json with a Next.js dependency to trigger detection
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "test-app",
        dependencies: { next: "14.0.0" },
        scripts: { dev: "next dev" },
      }),
    );
    await init({ json: true });
    expect(existsSync(join(tmpDir, "ide.yml"))).toBeTruthy();
    const output = JSON.parse(logged[0]);
    expect(output.created).toBe(true);
    expect(output.detected.length > 0).toBeTruthy();
  });

  it("rejects when ide.yml already exists", async () => {
    writeFileSync(join(tmpDir, "ide.yml"), "name: existing\n");
    await expect(init({ json: true })).rejects.toThrow();
  });

  it("rejects unknown template name", async () => {
    await expect(init({ template: "nonexistent-template-xyz", json: true })).rejects.toThrow();
  });

  it("replaces the name field with the directory basename", async () => {
    await init({ template: "default", json: true });
    const content = readFileSync(join(tmpDir, "ide.yml"), "utf-8");
    const dirName = tmpDir.split("/").pop();
    expect(content.includes(`name: ${dirName}`)).toBeTruthy();
  });

  it("prints human-readable output without --json", async () => {
    await init();
    expect(logged.some((l) => l.includes("Created ide.yml"))).toBeTruthy();
  });

  it("scaffolds missions skills, library, and AGENTS.md", async () => {
    await init({ template: "missions", json: true });

    expect(existsSync(join(tmpDir, ".tmux-ide", "skills", "frontend.md"))).toBeTruthy();
    expect(existsSync(join(tmpDir, ".tmux-ide", "skills", "backend.md"))).toBeTruthy();
    expect(existsSync(join(tmpDir, ".tmux-ide", "skills", "reviewer.md"))).toBeTruthy();
    expect(existsSync(join(tmpDir, ".tmux-ide", "skills", "researcher.md"))).toBeTruthy();
    expect(existsSync(join(tmpDir, ".tmux-ide", "library"))).toBeTruthy();
    expect(existsSync(join(tmpDir, "AGENTS.md"))).toBeTruthy();
    expect(readFileSync(join(tmpDir, "AGENTS.md"), "utf-8")).toContain(
      `## Project: ${join(tmpDir).split("/").pop()}`,
    );

    const output = JSON.parse(logged[0]);
    expect(output.template).toBe("missions");
    expect(output.paths.some((path: string) => path.endsWith("frontend.md"))).toBeTruthy();
  });
});
