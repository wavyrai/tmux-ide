/**
 * FilesSurface — Explorer rail + preview body.
 *
 * Stubs the daemon `fetchProjectFiles` API + the `CodeEditor`
 * component (no Monaco runtime under happy-dom). Asserts:
 *   - Tree renders the daemon's response.
 *   - File click opens the right renderer surface based on kind.
 *   - Text click drives a `registerDisk` Effect → status flips
 *     to `ready` → `<CodeEditor>` mounts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Effect } from "effect";

// FilesSurface migrated from an eager full-tree `fetchProjectFiles`
// to lazy per-folder `fetchFolderChildren` (one level deep, fetched
// on expand). The fixture is now a flat children-by-dir map keyed by
// the relative dir path ("" = workspace root).
const CHILDREN_BY_DIR: Record<
  string,
  Array<{ path: string; name: string; isDirectory: boolean }>
> = {
  "": [
    { path: "src", name: "src", isDirectory: true },
    { path: "README", name: "README", isDirectory: false },
  ],
  src: [
    { path: "src/index.ts", name: "index.ts", isDirectory: false },
    { path: "src/logo.png", name: "logo.png", isDirectory: false },
    { path: "src/notes.md", name: "notes.md", isDirectory: false },
  ],
};

vi.mock("@/lib/api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...orig,
    fetchFilePreview: vi.fn((_session: string, filePath: string) =>
      Effect.sync(() => ({
        file: filePath,
        exists: true,
        content: `// content of ${filePath}\n`,
      })),
    ),
  };
});

// Lazy rail loader + git-status. buildGitStatusMap / gitStatusTextClass
// are pure formatters — keep the originals; only the network legs are
// stubbed.
vi.mock("@/lib/editor/files-rail", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/editor/files-rail")>();
  return {
    ...orig,
    fetchFolderChildren: vi.fn(
      async (_session: string, dirPath: string) => CHILDREN_BY_DIR[dirPath] ?? [],
    ),
    fetchGitStatusForRail: vi.fn(() => Effect.succeed(null)),
  };
});

// `codeEditorPool.init()` calls the real @monaco-editor/loader which
// throws under happy-dom. The surface only fire-and-forgets it for
// pool warm-up, so a resolved no-op is faithful.
vi.mock("@/lib/monaco/code-pool", () => ({
  codeEditorPool: {
    init: vi.fn(async () => undefined),
    acquire: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("@/components/editor/CodeEditor", () => ({
  CodeEditor: (props: { uri: string }) => (
    <div data-testid="code-editor-stub" data-uri={props.uri} />
  ),
}));

// happy-dom doesn't ship a browser-compatible WebSocket — stub the
// FS-watch client out so the surface mounts without trying to
// open `/ws/events`.
vi.mock("@/lib/editor/fs-watch-client", () => ({
  startFsWatchClient: () => () => {},
}));

import { FilesSurface } from "@/components/files/FilesSurface";
import { modelRegistry } from "@/lib/monaco/model-registry";

// Stub Monaco so `registerDisk` can run end-to-end without pulling
// the editor bundle.
let nextModelId = 0;
const stubModels = new Map<
  string,
  { dispose: () => void; getValue: () => string; _value: string }
>();
const stubMonaco = {
  Uri: { parse: (s: string) => ({ _raw: s, toString: () => s }) },
  editor: {
    getModel: (uri: { _raw: string }) => stubModels.get(uri._raw),
    createModel: (value: string, _lang: string, uri: { _raw: string }) => {
      const m = {
        _value: value,
        getValue() {
          return this._value;
        },
        dispose() {
          stubModels.delete(uri._raw);
        },
        _id: nextModelId++,
      };
      stubModels.set(uri._raw, m);
      return m;
    },
  },
};

beforeEach(() => {
  (globalThis as unknown as { __monaco: typeof stubMonaco }).__monaco = stubMonaco;
  modelRegistry.notifyMonacoReady(
    stubMonaco as unknown as Parameters<typeof modelRegistry.notifyMonacoReady>[0],
  );
  modelRegistry._resetForTests();
  stubModels.clear();
  nextModelId = 0;
});

afterEach(() => {
  cleanup();
  modelRegistry._resetForTests();
});

/**
 * Lazy rail: only the workspace root is loaded on mount. Click the
 * `src` directory row to fetch + expand its children before
 * asserting on `src/*` files. Returns once a known child row is in
 * the DOM.
 */
async function expandSrc(
  findAllByTestId: (id: string) => Promise<HTMLElement[]>,
): Promise<HTMLElement[]> {
  const dirRows = await findAllByTestId("v2-files-row-dir");
  const srcRow = dirRows.find((r) => r.getAttribute("data-dir-path") === "src")!;
  fireEvent.click(srcRow);
  // Wait until the WHOLE expanded set has flushed — index.ts appears
  // first while logo.png / notes.md are still rendering, so keying
  // on a single child captures a partial snapshot. Require every
  // `src/*` child + the root README before returning.
  return waitFor(async () => {
    const rows = await findAllByTestId("v2-files-row");
    const paths = new Set(rows.map((r) => r.getAttribute("data-file-path")));
    for (const expected of ["src/index.ts", "src/logo.png", "src/notes.md", "README"]) {
      expect(paths.has(expected)).toBe(true);
    }
    return rows;
  });
}

describe("FilesSurface", () => {
  it("renders the explorer rail and lazily expands the daemon-supplied tree", async () => {
    const { findAllByTestId, findByTestId } = render(() => (
      <FilesSurface projectName="smoke" modelRootPath="/repo" />
    ));
    // Root load shows the `src` directory + the README file. Expanding
    // `src/` lazily fetches its three children.
    const dirRows = await findAllByTestId("v2-files-row-dir");
    expect(dirRows.length).toBeGreaterThanOrEqual(1);
    const fileRows = await expandSrc(findAllByTestId);
    expect(fileRows.length).toBeGreaterThanOrEqual(3);
    expect(await findByTestId("v2-files-empty-preview")).toBeInTheDocument();
  });

  it("single-click previews a text file via ShikiViewer (no Monaco)", async () => {
    const { findByTestId, queryByTestId, findAllByTestId } = render(() => (
      <FilesSurface projectName="smoke" modelRootPath="/repo" />
    ));
    const rows = await expandSrc(findAllByTestId);
    const indexTs = rows.find((r) => r.getAttribute("data-file-path") === "src/index.ts")!;
    fireEvent.click(indexTs);
    // Single click opens a read-only ShikiViewer preview tab — the
    // writable Monaco editor only mounts once the buffer is pinned.
    expect(await findByTestId("editor-shiki-viewer")).toBeInTheDocument();
    expect(queryByTestId("code-editor-stub")).toBeNull();
  });

  it("double-click pins the buffer and mounts CodeEditor at the file:// URI", async () => {
    const { findByTestId, findAllByTestId } = render(() => (
      <FilesSurface projectName="smoke" modelRootPath="/repo" />
    ));
    const rows = await expandSrc(findAllByTestId);
    const indexTs = rows.find((r) => r.getAttribute("data-file-path") === "src/index.ts")!;
    // Double-click pins the tab → ShikiViewer swaps to the writable
    // Monaco editor, attached to the file:// buffer URI (the
    // read-only disk:// URI is no longer the editor's target).
    fireEvent.dblClick(indexTs);
    const editor = await findByTestId("code-editor-stub");
    expect(editor.getAttribute("data-uri")).toBe("file:///repo/src/index.ts");
  });

  it("clicking a markdown file routes to MarkdownRenderer (not CodeEditor)", async () => {
    const { findByTestId, findAllByTestId, queryByTestId } = render(() => (
      <FilesSurface projectName="smoke" modelRootPath="/repo" />
    ));
    const rows = await expandSrc(findAllByTestId);
    const notesMd = rows.find((r) => r.getAttribute("data-file-path") === "src/notes.md")!;
    fireEvent.click(notesMd);
    // Wait until the registry's status flips to 'ready' (the
    // markdown renderer re-evaluates on bufferVersion ticks).
    await waitFor(() => {
      expect(modelRegistry.modelStatus("disk:///repo/src/notes.md")).toBe("ready");
    });
    expect(await findByTestId("editor-markdown-renderer")).toBeInTheDocument();
    expect(queryByTestId("code-editor-stub")).toBeNull();
  });

  it("clicking an image file routes to ImageRenderer with no registry register call", async () => {
    const { findByTestId, findAllByTestId } = render(() => (
      <FilesSurface projectName="smoke" modelRootPath="/repo" />
    ));
    const rows = await expandSrc(findAllByTestId);
    const png = rows.find((r) => r.getAttribute("data-file-path") === "src/logo.png")!;
    fireEvent.click(png);
    expect(await findByTestId("editor-image-renderer")).toBeInTheDocument();
    // Image kinds skip the registry — no `disk://` entry for the
    // PNG path.
    expect(modelRegistry.modelStatus("disk:///repo/src/logo.png")).toBe("loading");
  });
});
