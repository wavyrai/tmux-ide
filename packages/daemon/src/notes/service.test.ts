import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNote, writeNote } from "./service.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-notes-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readNote", () => {
  it("returns empty content + null updatedAt when no note exists", () => {
    const record = readNote(tmpDir);
    expect(record.content).toBe("");
    expect(record.updatedAt).toBeNull();
  });

  it("returns the file content + mtime when a note exists", () => {
    const notesDir = join(tmpDir, ".tmux-ide");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(join(notesDir, "notes.md"), "# hello\nworld");
    const record = readNote(tmpDir);
    expect(record.content).toBe("# hello\nworld");
    expect(record.updatedAt).not.toBeNull();
  });
});

describe("writeNote", () => {
  it("creates the .tmux-ide directory if missing", () => {
    expect(existsSync(join(tmpDir, ".tmux-ide"))).toBe(false);
    writeNote(tmpDir, "draft");
    expect(existsSync(join(tmpDir, ".tmux-ide", "notes.md"))).toBe(true);
  });

  it("writes content atomically and returns it back via readNote", () => {
    writeNote(tmpDir, "first");
    expect(readNote(tmpDir).content).toBe("first");
    writeNote(tmpDir, "second");
    expect(readNote(tmpDir).content).toBe("second");
  });

  it("does not leave .tmp files behind on a successful write", () => {
    writeNote(tmpDir, "x");
    const file = join(tmpDir, ".tmux-ide", "notes.md");
    expect(readFileSync(file, "utf8")).toBe("x");
  });
});
