import type { WorkspaceFilesCatalogEnvelopeV1 } from "@tmux-ide/contracts";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFilesFeatureSession,
  type FilesFeatureHost,
  type FilesFeatureIO,
} from "./session.ts";

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
    workspaceName: () => "tmux-ide",
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("FilesFeatureSession", () => {
  it("owns catalog state and projects it through one deferred session", async () => {
    const { directory, host } = await fixture();
    const session = createFilesFeatureSession(host);
    session.applyCatalog({
      resource: {
        status: "ready",
        workspaceName: "tmux-ide",
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

  it("rejects a catalog whose workspace identity does not match the host", async () => {
    const { host } = await fixture();
    const session = createFilesFeatureSession(host);
    session.applyCatalog({
      resource: {
        status: "ready",
        workspaceName: "other-workspace",
        entries: [
          {
            name: "foreign.ts",
            relativePath: "foreign.ts",
            kind: "file",
            hidden: false,
            ignored: false,
            gitStatus: null,
          },
        ],
      },
    } as WorkspaceFilesCatalogEnvelopeV1);
    expect(session.fileNodes()).toEqual([]);
    session.dispose();
  });

  it("discards an out-of-order directory read after the workspace changes", async () => {
    const first = await fixture();
    const second = await fixture();
    let root = first.directory;
    let workspaceName = "first";
    const pendingEntries = deferred<Awaited<ReturnType<FilesFeatureIO["readdir"]>>>();
    const io: FilesFeatureIO = {
      readFile: vi.fn(async () => {
        throw new Error("no ignore file");
      }) as FilesFeatureIO["readFile"],
      readdir: vi.fn(() => pendingEntries.promise) as FilesFeatureIO["readdir"],
      writeFile: vi.fn() as FilesFeatureIO["writeFile"],
      rename: vi.fn() as FilesFeatureIO["rename"],
      rm: vi.fn() as FilesFeatureIO["rm"],
    };
    const session = createFilesFeatureSession(
      {
        ...first.host,
        workspaceDir: () => root,
        workspaceName: () => workspaceName,
      },
      io,
    );
    session.setFileNodes([
      {
        name: "src",
        path: join(first.directory, "src"),
        isDir: true,
        depth: 0,
        expanded: false,
        ignored: false,
      },
    ]);
    session.activate(0);

    root = second.directory;
    workspaceName = "second";
    session.resetCatalog();
    pendingEntries.resolve([
      {
        name: "late.ts",
        isDirectory: () => false,
      } as Awaited<ReturnType<FilesFeatureIO["readdir"]>>[number],
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(session.fileNodes()).toEqual([]);
    session.dispose();
  });

  it("retires mutation completion callbacks when disposed", async () => {
    const { host } = await fixture();
    const pendingWrite = deferred<void>();
    const io: FilesFeatureIO = {
      readFile: vi.fn() as FilesFeatureIO["readFile"],
      readdir: vi.fn() as FilesFeatureIO["readdir"],
      writeFile: vi.fn(() => pendingWrite.promise) as FilesFeatureIO["writeFile"],
      rename: vi.fn() as FilesFeatureIO["rename"],
      rm: vi.fn() as FilesFeatureIO["rm"],
    };
    const session = createFilesFeatureSession(host, io);
    const creation = session.create(host.workspaceDir(), "late.ts");
    session.dispose();
    pendingWrite.resolve();
    await creation;

    expect(host.note).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
  });
});
