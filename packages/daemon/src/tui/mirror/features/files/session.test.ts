import type { WorkspaceFilesCatalogEnvelopeV1 } from "@tmux-ide/contracts";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFilesFeatureSession, type FilesFeatureHost } from "./session.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tmux-ide-files-session-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "README.md"), "hello\nworld\n");
  const refresh = vi.fn();
  const host: FilesFeatureHost = {
    workspaceDir: () => directory,
    width: () => 120,
    height: () => 30,
    hover: () => null,
    activePanel: () => "files",
    mode: () => "editor",
    activateFiles: vi.fn(),
    leaveFiles: vi.fn(),
    refresh,
    note: vi.fn(),
    initialShowHidden: false,
    initialShowIgnored: false,
    quitHint: "q quit",
  };
  return { directory, host, refresh };
}

describe("FilesFeatureSession", () => {
  it("owns catalog state and projects it through one deferred session", async () => {
    const { directory, host } = await fixture();
    const session = createFilesFeatureSession(host);
    session.applyCatalog({
      resource: {
        status: "ready",
        entries: [
          {
            name: "README.md",
            relativePath: "README.md",
            kind: "file",
            hidden: false,
            ignored: false,
            gitStatus: "modified",
          },
        ],
      },
    } as WorkspaceFilesCatalogEnvelopeV1);

    expect(session.selectedPath()).toBe(join(directory, "README.md"));
    expect(session.projection().rows).toHaveLength(1);
    expect(session.projection().rows[0]?.status).toBe("M");
    session.resetCatalog();
    expect(session.fileNodes()).toEqual([]);
    session.dispose();
  });

  it("destroys the native editor buffer with the reactive feature owner", async () => {
    const { directory } = await fixture();
    const moduleUrl = new URL("./session.ts", import.meta.url).href;
    const path = join(directory, "README.md");
    const script = `
      import { createFilesFeatureSession } from ${JSON.stringify(moduleUrl)};
      const session = createFilesFeatureSession({
        workspaceDir: () => ${JSON.stringify(directory)},
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
      session.openEditor(${JSON.stringify(path)});
      if (!session.hasBuffer) process.exit(2);
      if (JSON.stringify(session.editorLines()) !== JSON.stringify(["hello", "world", ""])) process.exit(3);
      session.dispose();
      if (session.hasBuffer) process.exit(4);
    `;
    const result = spawnSync("bun", ["--preload", "@opentui/solid/preload", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
