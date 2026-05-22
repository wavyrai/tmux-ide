import { describe, it, beforeEach, afterEach, expect } from "bun:test";
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
    expect(names).toEqual(["alpha-dir", "beta-dir", "apple.txt", "zebra.txt"]);
  });

  it("marks directories and files correctly", () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "file.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, false);
    const dir = entries.find((e) => e.name === "subdir");
    const file = entries.find((e) => e.name === "file.txt");
    expect(dir?.isDir).toBe(true);
    expect(file?.isDir).toBe(false);
  });

  it("filters ALWAYS_IGNORE entries like node_modules and .git", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    mkdirSync(join(tmpDir, ".git"));
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "file.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, false);
    const names = entries.map((e) => e.name);
    expect(!names.includes("node_modules")).toBeTruthy();
    expect(!names.includes(".git")).toBeTruthy();
    expect(names.includes("src")).toBeTruthy();
    expect(names.includes("file.txt")).toBeTruthy();
  });

  it("respects .gitignore patterns", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "*.log\nbuild/\n");
    writeFileSync(join(tmpDir, "app.log"), "log data");
    writeFileSync(join(tmpDir, "main.ts"), "code");
    mkdirSync(join(tmpDir, "build"));
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, true); // showHidden to see .gitignore
    const names = entries.map((e) => e.name);
    expect(!names.includes("app.log")).toBeTruthy();
    expect(!names.includes("build")).toBeTruthy();
    expect(names.includes("main.ts")).toBeTruthy();
  });

  it("hides hidden files when showHidden is false", () => {
    writeFileSync(join(tmpDir, ".hidden"), "");
    writeFileSync(join(tmpDir, "visible.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, false);
    const names = entries.map((e) => e.name);
    expect(!names.includes(".hidden")).toBeTruthy();
    expect(names.includes("visible.txt")).toBeTruthy();
  });

  it("shows hidden files when showHidden is true", () => {
    writeFileSync(join(tmpDir, ".hidden"), "");
    writeFileSync(join(tmpDir, "visible.txt"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(tmpDir, tmpDir, ig, true);
    const names = entries.map((e) => e.name);
    expect(names.includes(".hidden")).toBeTruthy();
    expect(names.includes("visible.txt")).toBeTruthy();
  });

  it("returns empty array for non-existent directory", () => {
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(join(tmpDir, "nonexistent"), tmpDir, ig, false);
    expect(entries).toEqual([]);
  });

  it("provides correct relative and absolute paths", () => {
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "file.ts"), "");
    const ig = createIgnoreFilter(tmpDir);
    const entries = readDirectory(join(tmpDir, "src"), tmpDir, ig, false);
    const file = entries.find((e) => e.name === "file.ts");
    expect(file).toBeTruthy();
    expect(file.path).toBe("src/file.ts");
    expect(file.absolutePath).toBe(join(tmpDir, "src", "file.ts"));
  });
});
