import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureRealDirectory,
  readRegularFile,
  UnsafeFileError,
  writeFileAtomic,
} from "./safe-files.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tmux-ide-safe-files-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("writeFileAtomic", () => {
  it("replaces a symlink at the path instead of writing through it", () => {
    const victim = join(root, "victim");
    writeFileSync(victim, "keep");
    const path = join(root, "store.json");
    symlinkSync(victim, path);
    writeFileAtomic(path, "new");
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("creates the directory, writes mode 0600 and leaves no temporary file", () => {
    const path = join(root, "a", "b", "store.json");
    writeFileAtomic(path, "x");
    writeFileAtomic(path, "y");
    expect(readFileSync(path, "utf8")).toBe("y");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "a", "b"))).toEqual(["store.json"]);
  });
});

describe("readRegularFile", () => {
  it("reads a regular file and returns null when there is none", () => {
    writeFileSync(join(root, "f"), "hello");
    expect(readRegularFile(join(root, "f"), 10)).toBe("hello");
    expect(readRegularFile(join(root, "missing"), 10)).toBeNull();
  });

  it("refuses symlinks, directories and files over the cap", () => {
    writeFileSync(join(root, "secret"), "token");
    symlinkSync(join(root, "secret"), join(root, "link"));
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "big"), "x".repeat(11));
    expect(() => readRegularFile(join(root, "link"), 10)).toThrow(/is a symlink/u);
    expect(() => readRegularFile(join(root, "dir"), 10)).toThrow(/not a regular file/u);
    expect(() => readRegularFile(join(root, "big"), 10)).toThrow(/larger than 10 bytes/u);
    expect(() => readRegularFile(join(root, "link"), 10)).toThrow(UnsafeFileError);
  });
});

describe("ensureRealDirectory", () => {
  it("creates a directory and accepts an existing one", () => {
    ensureRealDirectory(join(root, "data", "tasks"));
    ensureRealDirectory(join(root, "data", "tasks"));
    expect(lstatSync(join(root, "data", "tasks")).isDirectory()).toBe(true);
  });

  it("refuses a symlink or a file in its place", () => {
    mkdirSync(join(root, "data"));
    symlinkSync(root, join(root, "data", "link"));
    writeFileSync(join(root, "data", "file"), "");
    expect(() => ensureRealDirectory(join(root, "data", "link"))).toThrow(/not a real directory/u);
    expect(() => ensureRealDirectory(join(root, "data", "file"))).toThrow(/not a real directory/u);
  });
});
