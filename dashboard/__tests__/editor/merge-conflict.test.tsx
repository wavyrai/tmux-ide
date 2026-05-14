/**
 * G17-P7 — three-way merge UI tests.
 *
 * Covers:
 *   - `resolveConflict` buffer-store action wiring (content
 *     swap, externalContent clear, dirty recompute, autosave
 *     scheduling).
 *   - `<MergeConflictPanel>` render + action callbacks.
 *
 * Monaco + `<DiffPreview>` are stubbed so the panel mounts under
 * happy-dom without the editor bundle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { Effect } from "effect";

const mockSaveFile = vi.fn();
vi.mock("@/lib/api", () => ({
  API_BASE: "",
  ApiError: class ApiError extends Error {
    status = 0;
  },
  saveFile: (...args: unknown[]) => mockSaveFile(...args),
  fetchFilePreview: vi.fn(),
  fetchGitFile: vi.fn(),
  fetchProjectFiles: vi.fn(),
}));

// Stub `<DiffPreview>` so the merge panel mounts without touching
// `monaco.editor.createDiffEditor`. We only care about the panel's
// wiring + the buffer-store flow.
vi.mock("@/components/editor/DiffPreview", () => ({
  DiffPreview: (props: { id: string; original: string; modified: string }) => (
    <div
      data-testid="diff-preview-stub"
      data-diff-preview-id={props.id}
      data-original={props.original}
      data-modified={props.modified}
    />
  ),
}));

const stubModels = new Map<
  string,
  { _value: string; getValue(): string; setValue(v: string): void; dispose(): void }
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
        setValue(v: string) {
          this._value = v;
        },
        dispose() {
          stubModels.delete(uri._raw);
        },
      };
      stubModels.set(uri._raw, m);
      return m;
    },
  },
};

import {
  __resetBufferStoreForTests,
  _getAutosaveWindowMsForTests,
  _hasPendingAutosaveForTests,
  bufferState,
  markContent,
  markReady,
  openBuffer,
  reseedFromExternal,
  resolveConflict,
} from "@/lib/editor/buffer-store";
import { MergeConflictPanel } from "@/components/editor/MergeConflictPanel";
import { modelRegistry } from "@/lib/monaco/model-registry";

beforeEach(() => {
  (globalThis as unknown as { __monaco: typeof stubMonaco }).__monaco = stubMonaco;
  modelRegistry.notifyMonacoReady(
    stubMonaco as unknown as Parameters<typeof modelRegistry.notifyMonacoReady>[0],
  );
  modelRegistry._resetForTests();
  __resetBufferStoreForTests();
  stubModels.clear();
  mockSaveFile.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetBufferStoreForTests();
  modelRegistry._resetForTests();
});

function openConflict(opts?: { language?: string }) {
  const { bufferUri } = openBuffer({
    sessionName: "smoke",
    rootPath: "/repo",
    filePath: "src/x.ts",
    language: opts?.language ?? "typescript",
  });
  markReady(bufferUri, "base content\n");
  markContent(bufferUri, "my local edits\n");
  reseedFromExternal(bufferUri, "external rewrite\n");
  return bufferUri;
}

describe("resolveConflict (buffer-store)", () => {
  it("swaps buffer content to the merged value + clears externalContent", () => {
    const uri = openConflict();
    resolveConflict(uri, "merged result\n");
    const buf = bufferState.buffers[uri]!;
    expect(buf.content).toBe("merged result\n");
    expect(buf.externalContent).toBeNull();
    // baseContent stays at the previous on-disk snapshot; the
    // user's save flow promotes the merged result to disk.
    expect(buf.baseContent).toBe("base content\n");
    expect(buf.dirty).toBe(true);
    expect(modelRegistry.getValue(uri)).toBe("merged result\n");
    expect(modelRegistry.isDirty(uri)).toBe(true);
  });

  it("clears dirty when merged result matches baseContent", () => {
    const uri = openConflict();
    resolveConflict(uri, "base content\n");
    const buf = bufferState.buffers[uri]!;
    expect(buf.content).toBe("base content\n");
    expect(buf.dirty).toBe(false);
    expect(buf.externalContent).toBeNull();
    expect(modelRegistry.isDirty(uri)).toBe(false);
  });

  it("schedules autosave when the resolved merge remains dirty", async () => {
    vi.useFakeTimers();
    mockSaveFile.mockReturnValue(Effect.succeed({ ok: true, path: "src/x.ts", bytes: 0 }));
    const uri = openConflict();
    resolveConflict(uri, "merged result\n");
    expect(_hasPendingAutosaveForTests(uri)).toBe(true);
    await vi.advanceTimersByTimeAsync(_getAutosaveWindowMsForTests() + 50);
    expect(mockSaveFile).toHaveBeenCalledWith("smoke", "src/x.ts", "merged result\n");
  });

  it("is a no-op for an unknown buffer URI", () => {
    expect(() => resolveConflict("file:///nope", "anything")).not.toThrow();
  });
});

describe("MergeConflictPanel render + actions", () => {
  it("renders one hunk per merge-region with the right kind data attrs", () => {
    const uri = openConflict();
    const buf = bufferState.buffers[uri]!;
    const { getAllByTestId, getByTestId } = render(() => <MergeConflictPanel buffer={buf} />);
    expect(getByTestId("v2-merge-conflict-panel").getAttribute("data-buffer-uri")).toBe(uri);
    const hunks = getAllByTestId("v2-merge-hunk");
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    // At least one conflict hunk should be in the list — the fixture
    // diverges on the single body line.
    const conflict = hunks.find((h) => h.getAttribute("data-hunk-kind") === "conflict");
    expect(conflict).toBeDefined();
  });

  it("status bar reports `0 / N conflicts resolved` on first render", () => {
    const uri = openConflict();
    const buf = bufferState.buffers[uri]!;
    const { getByTestId } = render(() => <MergeConflictPanel buffer={buf} />);
    const panel = getByTestId("v2-merge-conflict-panel");
    expect(panel.getAttribute("data-resolved-conflicts")).toBe("0");
    expect(Number(panel.getAttribute("data-total-conflicts"))).toBeGreaterThanOrEqual(1);
    expect(getByTestId("v2-merge-status").textContent).toMatch(/0\s*\/\s*1/);
  });

  it("per-hunk Apply button auto-fires resolveConflict once every conflict is picked", () => {
    const uri = openConflict();
    const buf = bufferState.buffers[uri]!;
    const { getAllByTestId } = render(() => <MergeConflictPanel buffer={buf} />);
    // The fixture has exactly one conflict hunk; clicking Apply on
    // it should satisfy the "all resolved" gate and auto-fire
    // `resolveConflict` so externalContent clears.
    const applyButtons = getAllByTestId("v2-merge-hunk-apply-external");
    expect(applyButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(applyButtons[0]!);
    const after = bufferState.buffers[uri]!;
    expect(after.externalContent).toBeNull();
    expect(after.content).toBe("external rewrite\n");
    expect(after.dirty).toBe(true);
  });

  it("Keep button picks the local side, then auto-applies the merge", () => {
    const uri = openConflict();
    const buf = bufferState.buffers[uri]!;
    const { getAllByTestId } = render(() => <MergeConflictPanel buffer={buf} />);
    fireEvent.click(getAllByTestId("v2-merge-hunk-keep-local")[0]!);
    const after = bufferState.buffers[uri]!;
    expect(after.externalContent).toBeNull();
    expect(after.content).toBe("my local edits\n");
  });

  it("Combine button concatenates external + local for the conflict hunk", () => {
    const uri = openConflict();
    const buf = bufferState.buffers[uri]!;
    const { getAllByTestId } = render(() => <MergeConflictPanel buffer={buf} />);
    fireEvent.click(getAllByTestId("v2-merge-hunk-combine")[0]!);
    const after = bufferState.buffers[uri]!;
    expect(after.externalContent).toBeNull();
    // `combine` emits external lines first, then local lines.
    expect(after.content).toBe("external rewrite\nmy local edits\n");
  });

  it("bulk `Apply all external` resolves every pending conflict in one click", () => {
    // Two conflict hunks via two divergent line pairs.
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/multi.ts",
      language: "typescript",
    });
    markReady(bufferUri, "a\nb\nc\nd\ne\n");
    markContent(bufferUri, "a\nLB\nc\nLD\ne\n");
    reseedFromExternal(bufferUri, "a\nXB\nc\nXD\ne\n");
    const buf = bufferState.buffers[bufferUri]!;
    const { getByTestId } = render(() => <MergeConflictPanel buffer={buf} />);
    expect(
      Number(getByTestId("v2-merge-conflict-panel").getAttribute("data-total-conflicts")),
    ).toBeGreaterThanOrEqual(2);
    fireEvent.click(getByTestId("v2-merge-bulk-external"));
    const after = bufferState.buffers[bufferUri]!;
    expect(after.externalContent).toBeNull();
    expect(after.content).toBe("a\nXB\nc\nXD\ne\n");
  });

  it("Use external (footer) still drives acceptExternalChange", () => {
    const uri = openConflict();
    const buf = bufferState.buffers[uri]!;
    const { getByTestId } = render(() => <MergeConflictPanel buffer={buf} />);
    fireEvent.click(getByTestId("v2-merge-use-external"));
    const after = bufferState.buffers[uri]!;
    expect(after.content).toBe("external rewrite\n");
    expect(after.baseContent).toBe("external rewrite\n");
    expect(after.dirty).toBe(false);
    expect(after.externalContent).toBeNull();
  });

  it("Use mine (footer) still drives dismissExternalChange", () => {
    const uri = openConflict();
    const buf = bufferState.buffers[uri]!;
    const { getByTestId } = render(() => <MergeConflictPanel buffer={buf} />);
    fireEvent.click(getByTestId("v2-merge-use-mine"));
    const after = bufferState.buffers[uri]!;
    expect(after.content).toBe("my local edits\n");
    expect(after.dirty).toBe(true);
    expect(after.externalContent).toBeNull();
  });
});
