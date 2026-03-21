import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIgnoreFilter, readDirectory } from "./files.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-files-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readDirectory", () => {
  it("returns sorted entries with directories first", () => {
    mkdirSync(join(tmpDir, "beta-dir"));
    mkdirSync(join(tmpDir, "alpha-dir"));
    writeFileSync(join(tmpDir, "zebra.txt"), "");
    writeFileSync(join(tmpDir, "apple.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, false);
    const names = entries.map((e) => e.name);
    assert.deepStrictEqual(names, ["alpha-dir", "beta-dir", "apple.txt", "zebra.txt"]);
  });

  it("marks directories and files correctly", () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "file.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, false);
    const dir = entries.find((e) => e.name === "subdir");
    const file = entries.find((e) => e.name === "file.txt");
    assert.strictEqual(dir?.isDir, true);
    assert.strictEqual(file?.isDir, false);
  });

  it("filters ALWAYS_IGNORE entries like node_modules and .git", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    mkdirSync(join(tmpDir, ".git"));
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "file.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, false);
    const names = entries.map((e) => e.name);
    assert.ok(!names.includes("node_modules"));
    assert.ok(!names.includes(".git"));
    assert.ok(names.includes("src"));
    assert.ok(names.includes("file.txt"));
  });

  it("respects .gitignore patterns", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "*.log\nbuild/\n");
    writeFileSync(join(tmpDir, "app.log"), "log data");
    writeFileSync(join(tmpDir, "main.ts"), "code");
    mkdirSync(join(tmpDir, "build"));
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, true); // showHidden to see .gitignore
    const names = entries.map((e) => e.name);
    assert.ok(!names.includes("app.log"));
    assert.ok(!names.includes("build"));
    assert.ok(names.includes("main.ts"));
  });

  it("hides hidden files when showHidden is false", () => {
    writeFileSync(join(tmpDir, ".hidden"), "");
    writeFileSync(join(tmpDir, "visible.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, false);
    const names = entries.map((e) => e.name);
    assert.ok(!names.includes(".hidden"));
    assert.ok(names.includes("visible.txt"));
  });

  it("shows hidden files when showHidden is true", () => {
    writeFileSync(join(tmpDir, ".hidden"), "");
    writeFileSync(join(tmpDir, "visible.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, true);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes(".hidden"));
    assert.ok(names.includes("visible.txt"));
  });

  it("returns empty array for non-existent directory", () => {
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(join(tmpDir, "nonexistent"), tmpDir, ig, false);
    assert.deepStrictEqual(entries, []);
  });

  it("provides correct relative and absolute paths", () => {
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "file.ts"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(join(tmpDir, "src"), tmpDir, ig, false);
    const file = entries.find((e) => e.name === "file.ts");
    assert.ok(file);
    assert.strictEqual(file.path, "src/file.ts");
    assert.strictEqual(file.absolutePath, join(tmpDir, "src", "file.ts"));
  });
});
