import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { createFilesFeatureSession } from "./session.ts";

test("destroys the native editor buffer with the reactive feature owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tmux-ide-files-native-buffer-"));
  const path = join(directory, "README.md");
  writeFileSync(path, "hello\nworld\n");
  try {
    const session = createFilesFeatureSession({
      workspaceDir: () => directory,
      workspaceName: () => "tmux-ide",
      width: () => 120,
      height: () => 30,
      hover: () => null,
      activePanel: () => "files",
      mode: () => "editor",
      activateFiles() {},
      leaveFiles() {},
      refresh() {},
      note() {},
      initialShowHidden: false,
      initialShowIgnored: false,
      quitHint: "q quit",
    });
    await session.openEditor(path);
    expect(session.hasBuffer).toBe(true);
    expect(session.editorLines()).toEqual(["hello", "world", ""]);
    session.dispose();
    expect(session.hasBuffer).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import * as fs from "node:fs/promises";
import {
  readEditorFile,
  saveEditorFile,
  MAX_EDITOR_LINES,
  MAX_PREVIEW_BYTES,
} from "./editor-file-io.ts";
import type { FilesFeatureIO } from "./session.ts";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function nativeFixture(overrides: Partial<FilesFeatureIO> = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), "files-async-native-"));
  const first = join(directory, "first");
  const second = join(directory, "second");
  await fs.writeFile(first, "first");
  await fs.writeFile(second, "second");
  let workspace = "one";
  const session = createFilesFeatureSession(
    {
      workspaceDir: () => directory,
      workspaceName: () => workspace,
      width: () => 120,
      height: () => 30,
      hover: () => null,
      activePanel: () => "files",
      mode: () => "editor",
      activateFiles() {},
      leaveFiles() {},
      refresh() {},
      note() {},
      initialShowHidden: false,
      initialShowIgnored: false,
      quitHint: "q quit",
    },
    {
      readFile: fs.readFile,
      readdir: fs.readdir,
      writeFile: fs.writeFile,
      rename: fs.rename,
      rm: fs.rm,
      ...overrides,
    },
  );
  return {
    session,
    first,
    second,
    directory,
    workspace: (name: string) => {
      workspace = name;
    },
    cleanup: async () => {
      session.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
test("keeps the native buffer responsive and protects edits while a load is delayed", async () => {
  const gate = deferred<void>();
  let delay = false;
  const fixture = await nativeFixture({
    readEditorFile: async (path, signal) => {
      if (delay) await gate.promise;
      return readEditorFile(path, signal);
    },
  });
  try {
    await fixture.session.openEditor(fixture.first);
    delay = true;
    const loading = fixture.session.openEditor(fixture.second);
    let ticked = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        ticked = true;
        resolve();
      }, 0),
    );
    expect(ticked).toBe(true);
    expect(fixture.session.insertText("edit-")).toBe(true);
    gate.resolve();
    await loading;
    expect(fixture.session.editorPath()).toBe(fixture.first);
    expect(fixture.session.editorLines().join("\n")).toBe("edit-first");
    expect(fixture.session.editorMessage()).toContain("changed while loading");
    await fixture.session.openEditor(fixture.second);
    expect(fixture.session.editorLines()).toEqual(["second"]); // later explicit navigation may discard prior edits
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});
test("latest load wins and retired workspace/disposal results never allocate a new buffer", async () => {
  const gate = deferred<void>();
  let calls = 0;
  const fixture = await nativeFixture({
    readEditorFile: async (path, signal) => {
      if (++calls === 1) await gate.promise;
      return readEditorFile(path, signal);
    },
  });
  try {
    const old = fixture.session.openEditor(fixture.first);
    await fixture.session.openEditor(fixture.second);
    gate.resolve();
    await old;
    expect(fixture.session.editorPath()).toBe(fixture.second);
    fixture.workspace("other");
    await fixture.session.save();
    expect(fixture.session.hasBuffer).toBe(false);
    expect(await fs.readFile(fixture.second, "utf8")).toBe("second");
    fixture.session.dispose();
    await fixture.session.openEditor(fixture.first);
    expect(fixture.session.hasBuffer).toBe(false);
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});
test("serializes captured save requests and never marks edits made during writes clean", async () => {
  const gate = deferred<void>();
  const snapshots: string[] = [];
  let active = 0;
  let maximum = 0;
  const fixture = await nativeFixture({
    saveEditorFile: async (path, text, signal, current) => {
      active++;
      maximum = Math.max(maximum, active);
      snapshots.push(text);
      if (snapshots.length === 1) await gate.promise;
      try {
        await saveEditorFile(path, text, signal, current);
      } finally {
        active--;
      }
    },
  });
  try {
    await fixture.session.openEditor(fixture.first);
    fixture.session.insertText("a");
    const saving = fixture.session.save();
    await Promise.resolve(); // first snapshot entered the writer
    fixture.session.insertText("b");
    const again = fixture.session.save();
    fixture.session.insertText("c");
    gate.resolve();
    await saving;
    await again;
    expect(maximum).toBe(1);
    expect(snapshots).toEqual(["afirst", "abfirst"]);
    expect(await fs.readFile(fixture.first, "utf8")).toBe("abfirst");
    expect(fixture.session.editorLines()).toEqual(["abcfirst"]);
    expect(fixture.session.editorModified()).toBe(true);
    expect(fixture.session.editorMessage()).toContain("newer edits");
    await fixture.session.save();
    expect(fixture.session.editorModified()).toBe(false);
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});
test("navigation/disposal cancel saves before commit without changing another buffer", async () => {
  const gate = deferred<void>();
  const fixture = await nativeFixture({
    saveEditorFile: async (path, text, signal, current) => {
      await gate.promise;
      await saveEditorFile(path, text, signal, current);
    },
  });
  try {
    await fixture.session.openEditor(fixture.first);
    fixture.session.insertText("unsaved-");
    const saving = fixture.session.save();
    await fixture.session.openEditor(fixture.second);
    gate.resolve();
    await saving;
    expect(await fs.readFile(fixture.first, "utf8")).toBe("first");
    expect(fixture.session.editorPath()).toBe(fixture.second);
    expect(fixture.session.editorModified()).toBe(false);
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});
test("allocates only bounded native preview text and lines and rejects preview edits", async () => {
  const fixture = await nativeFixture();
  try {
    const handle = await fs.open(fixture.first, "w");
    await handle.truncate(2 ** 31);
    await handle.close();
    await fixture.session.openEditor(fixture.first);
    expect(fixture.session.editorReadOnly()).toBe("preview");
    expect(fixture.session.editorMessage()).toContain("truncated preview");
    expect(fixture.session.editorLines().join("\n").length).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(fixture.session.insertText("no")).toBe(false);
    await fs.writeFile(fixture.second, "\n".repeat(100_000));
    await fixture.session.openEditor(fixture.second, 90_000);
    expect(fixture.session.editorLines().length).toBe(MAX_EDITOR_LINES);
    expect(fixture.session.editorCursor().row).toBe(MAX_EDITOR_LINES - 1);
    expect(fixture.session.editorReadOnly()).toBe("preview");
  } finally {
    await fixture.cleanup();
  }
});
test("disposal during pending native load/save fences completion and preserves disk content", async () => {
  const loadGate = deferred<void>();
  const loadingFixture = await nativeFixture({
    readEditorFile: async (path, signal) => {
      await loadGate.promise;
      return readEditorFile(path, signal);
    },
  });
  try {
    const loading = loadingFixture.session.openEditor(loadingFixture.first);
    loadingFixture.session.dispose();
    loadGate.resolve();
    await loading;
    expect(loadingFixture.session.hasBuffer).toBe(false);
  } finally {
    loadGate.resolve();
    await loadingFixture.cleanup();
  }
  const saveGate = deferred<void>();
  const savingFixture = await nativeFixture({
    saveEditorFile: async (path, text, signal, current) => {
      await saveGate.promise;
      return saveEditorFile(path, text, signal, current);
    },
  });
  try {
    await savingFixture.session.openEditor(savingFixture.first);
    savingFixture.session.insertText("discard-");
    const saving = savingFixture.session.save();
    savingFixture.session.dispose();
    saveGate.resolve();
    await saving;
    expect(await fs.readFile(savingFixture.first, "utf8")).toBe("first");
    expect(savingFixture.session.hasBuffer).toBe(false);
  } finally {
    saveGate.resolve();
    await savingFixture.cleanup();
  }
});
test("workspace changes during a delayed load reject its result", async () => {
  const gate = deferred<void>();
  const fixture = await nativeFixture({
    readEditorFile: async (path, signal) => {
      await gate.promise;
      return readEditorFile(path, signal);
    },
  });
  try {
    const loading = fixture.session.openEditor(fixture.first);
    fixture.workspace("replacement");
    gate.resolve();
    await loading;
    expect(fixture.session.hasBuffer).toBe(false);
  } finally {
    gate.resolve();
    await fixture.cleanup();
  }
});

test("rejects oversized native edits and reuses line projection on cursor movement", async () => {
  const fixture = await nativeFixture();
  try {
    await fixture.session.openEditor(fixture.first);
    const lines = fixture.session.editorLines();
    fixture.session.key({ name: "right" });
    expect(fixture.session.editorLines()).toBe(lines);
    expect(fixture.session.insertText("x".repeat(1024 * 1024))).toBe(false);
    expect(fixture.session.insertText("\n".repeat(MAX_EDITOR_LINES))).toBe(false);
    expect(fixture.session.editorLines()).toEqual(["first"]);
    expect(fixture.session.editorModified()).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("drains a save admitted between writer settlement and flight retirement", async () => {
  let lateSave: Promise<void> | undefined;
  const snapshots: string[] = [];
  const fixture = await nativeFixture({
    saveEditorFile: async (_path, text) => {
      snapshots.push(text);
      if (snapshots.length === 1)
        queueMicrotask(() =>
          queueMicrotask(() => {
            fixture.session.insertText("b");
            lateSave = fixture.session.save();
          }),
        );
    },
  });
  try {
    await fixture.session.openEditor(fixture.first);
    fixture.session.insertText("a");
    await fixture.session.save();
    await lateSave;
    expect(snapshots).toEqual(["afirst", "abfirst"]);
    expect(fixture.session.editorModified()).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
