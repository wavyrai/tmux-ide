import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { createFilesFeatureSession } from "./session.ts";

test("destroys the native editor buffer with the reactive feature owner", () => {
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
    session.openEditor(path);
    expect(session.hasBuffer).toBe(true);
    expect(session.editorLines()).toEqual(["hello", "world", ""]);
    session.dispose();
    expect(session.hasBuffer).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
