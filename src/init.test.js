import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdeError } from "./lib/errors.js";
import { init } from "./init.js";

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
    assert.ok(existsSync(join(tmpDir, "ide.yml")));
    const output = JSON.parse(logged[0]);
    assert.strictEqual(output.created, true);
    assert.strictEqual(output.template, "default");
  });

  it("creates ide.yml from named template", async () => {
    await init({ template: "nextjs", json: true });
    assert.ok(existsSync(join(tmpDir, "ide.yml")));
    const content = readFileSync(join(tmpDir, "ide.yml"), "utf-8");
    assert.ok(content.includes("rows"));
    const output = JSON.parse(logged[0]);
    assert.strictEqual(output.created, true);
    assert.strictEqual(output.template, "nextjs");
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
    assert.ok(existsSync(join(tmpDir, "ide.yml")));
    const output = JSON.parse(logged[0]);
    assert.strictEqual(output.created, true);
    assert.ok(output.detected.length > 0);
  });

  it("rejects when ide.yml already exists", async () => {
    writeFileSync(join(tmpDir, "ide.yml"), "name: existing\n");
    await assert.rejects(
      () => init({ json: true }),
      (err) => err instanceof IdeError && err.message.includes("already exists"),
    );
  });

  it("rejects unknown template name", async () => {
    await assert.rejects(
      () => init({ template: "nonexistent-template-xyz", json: true }),
      (err) => err instanceof IdeError && err.message.includes("not found"),
    );
  });

  it("replaces the name field with the directory basename", async () => {
    await init({ template: "default", json: true });
    const content = readFileSync(join(tmpDir, "ide.yml"), "utf-8");
    const dirName = tmpDir.split("/").pop();
    assert.ok(content.includes(`name: ${dirName}`));
  });

  it("prints human-readable output without --json", async () => {
    await init();
    assert.ok(logged.some((l) => l.includes("Created ide.yml")));
  });
});
