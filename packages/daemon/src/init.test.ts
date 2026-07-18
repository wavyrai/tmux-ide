import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "./init.ts";
import yaml from "js-yaml";
import { WorkspaceConfigV1SchemaZ } from "@tmux-ide/contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, "..", "..", "..", "templates");

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
  it("ships only valid WorkspaceConfigV1 YAML templates", () => {
    for (const file of readdirSync(templatesDir)) {
      if (!file.endsWith(".yml")) continue;
      const parsed = yaml.load(readFileSync(join(templatesDir, file), "utf-8"));
      expect(() => WorkspaceConfigV1SchemaZ.parse(parsed)).not.toThrow();
    }
  });

  it("creates workspace.yml from default template when no stack detected", async () => {
    await init({ json: true });
    expect(existsSync(join(tmpDir, ".tmux-ide", "workspace.yml"))).toBeTruthy();
    const output = JSON.parse(logged[0]);
    expect(output.created).toBe(true);
    expect(output.template).toBe("default");
  });

  it("creates workspace.yml from named template", async () => {
    await init({ template: "nextjs", json: true });
    expect(existsSync(join(tmpDir, ".tmux-ide", "workspace.yml"))).toBeTruthy();
    const content = readFileSync(join(tmpDir, ".tmux-ide", "workspace.yml"), "utf-8");
    expect(content.includes("terminal")).toBeTruthy();
    const output = JSON.parse(logged[0]);
    expect(output.created).toBe(true);
    expect(output.template).toBe("nextjs");
  });

  it("creates workspace.yml from detected stack", async () => {
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
    expect(existsSync(join(tmpDir, ".tmux-ide", "workspace.yml"))).toBeTruthy();
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
    const content = readFileSync(join(tmpDir, ".tmux-ide", "workspace.yml"), "utf-8");
    const dirName = tmpDir.split("/").pop();
    expect(content.includes(`name: ${dirName}`)).toBeTruthy();
  });

  it("writes a new workspace config at the git project root when invoked from a nested dir", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    const nested = join(tmpDir, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);

    await init({ json: true });

    expect(existsSync(join(tmpDir, ".tmux-ide", "workspace.yml"))).toBeTruthy();
    expect(existsSync(join(nested, ".tmux-ide", "workspace.yml"))).toBeFalsy();
    const content = readFileSync(join(tmpDir, ".tmux-ide", "workspace.yml"), "utf-8");
    expect(content.includes("version: 1")).toBeTruthy();
  });

  it("rejects when a winning nested workspace config already exists", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    const app = join(tmpDir, "apps", "web");
    const nested = join(app, "src");
    mkdirSync(join(app, ".tmux-ide"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(app, ".tmux-ide", "workspace.yml"),
      "version: 1\nname: web\nterminal:\n  rows:\n    - panes:\n        - title: Shell\n",
    );
    process.chdir(nested);

    await expect(init({ json: true })).rejects.toMatchObject({ code: "EXISTS" });
    expect(existsSync(join(tmpDir, ".tmux-ide", "workspace.yml"))).toBeFalsy();
  });

  it("prints human-readable output without --json", async () => {
    await init();
    expect(logged.some((l) => l.includes("Created .tmux-ide/workspace.yml"))).toBeTruthy();
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
