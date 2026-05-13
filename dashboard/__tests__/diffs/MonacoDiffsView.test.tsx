/**
 * MonacoDiffsView — file rail + StickyDiffEditor body.
 *
 * Stubs the daemon's `fetchProjectDiff` + the StickyDiffEditor
 * component (no Monaco runtime under happy-dom). Asserts:
 *   - Rail renders the changed files from the daemon.
 *   - Clicking a file selects it + mounts the diff editor against
 *     `git://...HEAD` (original) and `disk://...` (modified) URIs.
 *   - Accept / Reject callbacks receive both the file path + the
 *     typed hunk range.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Effect } from "effect";

let lastEditorProps: {
  originalUri: string;
  modifiedUri: string;
  onAcceptHunk?: (h: unknown) => void;
  onRejectHunk?: (h: unknown) => void;
} | null = null;

vi.mock("@/lib/api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...orig,
    fetchProjectDiff: vi.fn(() =>
      Effect.succeed({
        diff: "diff text",
        files: [
          { file: "src/index.ts", additions: 5, deletions: 2 },
          { file: "README.md", additions: 1, deletions: 0 },
        ],
      }),
    ),
    fetchFilePreview: vi.fn(() =>
      Effect.succeed({ file: "ignored", exists: true, content: "" }),
    ),
    fetchGitFile: vi.fn(() =>
      Effect.succeed({ path: "ignored", ref: "HEAD", exists: true, content: "" }),
    ),
  };
});

vi.mock("@/components/editor/StickyDiffEditor", () => ({
  StickyDiffEditor: (props: {
    originalUri: string;
    modifiedUri: string;
    onAcceptHunk?: (h: unknown) => void;
    onRejectHunk?: (h: unknown) => void;
  }) => {
    lastEditorProps = props;
    return (
      <div
        data-testid="sticky-diff-editor-stub"
        data-original-uri={props.originalUri}
        data-modified-uri={props.modifiedUri}
      />
    );
  },
}));

import { MonacoDiffsView } from "@/components/diffs/MonacoDiffsView";
import { modelRegistry } from "@/lib/monaco/model-registry";

// Minimal Monaco stub so registerDisk / registerGit succeed.
const stubMonaco = {
  Uri: { parse: (s: string) => ({ _raw: s, toString: () => s }) },
  editor: {
    getModel: () => undefined,
    createModel: (value: string) => ({
      _value: value,
      getValue() {
        return this._value;
      },
      dispose() {},
    }),
  },
};

beforeEach(() => {
  lastEditorProps = null;
  (globalThis as unknown as { __monaco: typeof stubMonaco }).__monaco = stubMonaco;
  modelRegistry.notifyMonacoReady(
    stubMonaco as unknown as Parameters<typeof modelRegistry.notifyMonacoReady>[0],
  );
  modelRegistry._resetForTests();
});

afterEach(() => {
  cleanup();
  modelRegistry._resetForTests();
});

describe("MonacoDiffsView", () => {
  it("renders the file rail from the daemon's diff summary", async () => {
    const { findByTestId, findAllByTestId } = render(() => (
      <MonacoDiffsView projectName="smoke" modelRootPath="/repo" />
    ));
    // findAllByTestId waits for the resource to flip from loading
    // → 2-file payload; the summary text follows the same signal.
    const files = await findAllByTestId("v2-monaco-diffs-file");
    expect(files).toHaveLength(2);
    await waitFor(() =>
      expect(findByTestId("v2-monaco-diffs-summary")).resolves.toHaveTextContent(
        "2 files changed",
      ),
    );
    expect(await findByTestId("v2-monaco-diffs-empty-preview")).toBeInTheDocument();
  });

  it("clicking a file mounts the diff editor with git:// + disk:// URIs", async () => {
    const { findAllByTestId, findByTestId } = render(() => (
      <MonacoDiffsView projectName="smoke" modelRootPath="/repo" />
    ));
    const rows = await findAllByTestId("v2-monaco-diffs-file");
    const indexTs = rows.find((r) => r.getAttribute("data-diff-file-path") === "src/index.ts")!;
    fireEvent.click(indexTs);
    const stub = await findByTestId("sticky-diff-editor-stub");
    expect(stub.getAttribute("data-original-uri")).toBe("git://repo/src/index.ts/HEAD");
    expect(stub.getAttribute("data-modified-uri")).toBe("disk:///repo/src/index.ts");
  });

  it("Accept / Reject callbacks receive (filePath, hunk)", async () => {
    const accepts: Array<[string, unknown]> = [];
    const rejects: Array<[string, unknown]> = [];
    const { findAllByTestId, findByTestId } = render(() => (
      <MonacoDiffsView
        projectName="smoke"
        modelRootPath="/repo"
        onAcceptHunk={(f, h) => accepts.push([f, h])}
        onRejectHunk={(f, h) => rejects.push([f, h])}
      />
    ));
    const rows = await findAllByTestId("v2-monaco-diffs-file");
    fireEvent.click(rows[0]!);
    await findByTestId("sticky-diff-editor-stub");
    await waitFor(() => expect(lastEditorProps).not.toBeNull());
    const sample = {
      originalStartLine: 1,
      originalEndLine: 1,
      modifiedStartLine: 1,
      modifiedEndLine: 3,
    };
    lastEditorProps!.onAcceptHunk!(sample);
    lastEditorProps!.onRejectHunk!(sample);
    expect(accepts).toEqual([["src/index.ts", sample]]);
    expect(rejects).toEqual([["src/index.ts", sample]]);
  });
});
