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

const TREE_FIXTURE = {
  maxDepth: 2,
  truncated: false,
  tree: [
    {
      path: "src",
      name: "src",
      isDirectory: true,
      children: [
        { path: "src/index.ts", name: "index.ts", isDirectory: false },
        { path: "src/logo.png", name: "logo.png", isDirectory: false },
        { path: "src/notes.md", name: "notes.md", isDirectory: false },
      ],
    },
    { path: "README", name: "README", isDirectory: false },
  ],
};

vi.mock("@/lib/api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...orig,
    fetchProjectFiles: vi.fn(() => Effect.sync(() => TREE_FIXTURE)),
    fetchFilePreview: vi.fn((_session: string, filePath: string) =>
      Effect.sync(() => ({
        file: filePath,
        exists: true,
        content: `// content of ${filePath}\n`,
      })),
    ),
  };
});

vi.mock("@/components/editor/CodeEditor", () => ({
  CodeEditor: (props: { uri: string }) => (
    <div data-testid="code-editor-stub" data-uri={props.uri} />
  ),
}));

import { FilesSurface } from "@/components/files/FilesSurface";
import { modelRegistry } from "@/lib/monaco/model-registry";

// Stub Monaco so `registerDisk` can run end-to-end without pulling
// the editor bundle.
let nextModelId = 0;
const stubModels = new Map<string, { dispose: () => void; getValue: () => string; _value: string }>();
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

describe("FilesSurface", () => {
  it("renders the explorer rail with the daemon-supplied tree", async () => {
    const { findAllByTestId, findByTestId } = render(() => (
      <FilesSurface projectName="smoke" modelRootPath="/repo" />
    ));
    // Top-level row is the `src` directory + the README file. Inside
    // `src/` (auto-expanded for depth 0) three rows show. The tree
    // resolves asynchronously; use findAllByTestId so the waitFor
    // gives the createResource time to flip from loading → data.
    const dirRows = await findAllByTestId("v2-files-row-dir");
    const fileRows = await findAllByTestId("v2-files-row");
    expect(dirRows.length).toBeGreaterThanOrEqual(1);
    expect(fileRows.length).toBeGreaterThanOrEqual(2);
    expect(await findByTestId("v2-files-empty-preview")).toBeInTheDocument();
  });

  it("clicking a text file mounts a CodeEditor against the disk URI", async () => {
    const { findByTestId, findAllByTestId } = render(() => (
      <FilesSurface projectName="smoke" modelRootPath="/repo" />
    ));
    const rows = await findAllByTestId("v2-files-row");
    const indexTs = rows.find((r) => r.getAttribute("data-file-path") === "src/index.ts")!;
    fireEvent.click(indexTs);
    // Wait for the disk registration to complete + the editor to
    // attach.
    const editor = await findByTestId("code-editor-stub");
    expect(editor.getAttribute("data-uri")).toBe("disk:///repo/src/index.ts");
  });

  it("clicking a markdown file routes to MarkdownRenderer (not CodeEditor)", async () => {
    const { findByTestId, findAllByTestId, queryByTestId } = render(() => (
      <FilesSurface projectName="smoke" modelRootPath="/repo" />
    ));
    const rows = await findAllByTestId("v2-files-row");
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
    const rows = await findAllByTestId("v2-files-row");
    const png = rows.find((r) => r.getAttribute("data-file-path") === "src/logo.png")!;
    fireEvent.click(png);
    expect(await findByTestId("editor-image-renderer")).toBeInTheDocument();
    // Image kinds skip the registry — no `disk://` entry for the
    // PNG path.
    expect(modelRegistry.modelStatus("disk:///repo/src/logo.png")).toBe("loading");
  });
});
