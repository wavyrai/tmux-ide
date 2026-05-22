/**
 * StickyDiffEditor — Solid component test.
 *
 * Monaco's diff editor is stubbed at the module level. The test
 * focuses on the wire-up (mount → onDidUpdateDiff → hunk list →
 * Accept/Reject callbacks). The actual `setModel` plumbing is
 * exercised by the registry tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

type DiffUpdateListener = () => void;
type ContentSizeListener = (e: { contentHeightChanged: boolean; contentHeight: number }) => void;

interface StubDiffEditor {
  setModel: (m: unknown) => void;
  updateOptions: (opts: unknown) => void;
  dispose: () => void;
  getModel: () => unknown;
  getModifiedEditor: () => {
    getContentHeight: () => number;
    onDidContentSizeChange: (cb: ContentSizeListener) => { dispose: () => void };
    revealLineNearTop: (line: number) => void;
    setPosition: (pos: unknown) => void;
    focus: () => void;
  };
  getOriginalEditor: () => unknown;
  onDidUpdateDiff: (cb: DiffUpdateListener) => { dispose: () => void };
  layout: () => void;
  getLineChanges: () => Array<{
    originalStartLineNumber: number;
    originalEndLineNumber: number;
    modifiedStartLineNumber: number;
    modifiedEndLineNumber: number;
  }>;
}

let lastEditor: StubDiffEditor | null = null;
let updateDiffListeners: DiffUpdateListener[] = [];
let lineChangesNext: StubDiffEditor["getLineChanges"] extends () => infer R ? R : never = [];

function makeStubMonaco() {
  return {
    Uri: { parse: (s: string) => ({ toString: () => s, _raw: s, scheme: s.split("://")[0] }) },
    editor: {
      createDiffEditor: () => {
        const editor: StubDiffEditor = {
          setModel: () => {},
          updateOptions: () => {},
          dispose: () => {},
          getModel: () => null,
          getModifiedEditor: () => ({
            getContentHeight: () => 320,
            onDidContentSizeChange: () => ({ dispose: () => {} }),
            revealLineNearTop: () => {},
            setPosition: () => {},
            focus: () => {},
          }),
          getOriginalEditor: () => ({}),
          onDidUpdateDiff: (cb: DiffUpdateListener) => {
            updateDiffListeners.push(cb);
            return { dispose: () => {} };
          },
          layout: () => {},
          getLineChanges: () => lineChangesNext,
        };
        lastEditor = editor;
        return editor;
      },
      getModel: () => undefined,
      createModel: () => ({ getValue: () => "", dispose: () => {} }),
    },
  };
}

vi.mock("@/lib/monaco/diff-pool", () => ({
  diffEditorPool: { init: () => Promise.resolve() },
}));

import { StickyDiffEditor, type DiffHunk } from "@/components/editor/StickyDiffEditor";
import { modelRegistry } from "@/lib/monaco/model-registry";

beforeEach(() => {
  lastEditor = null;
  updateDiffListeners = [];
  lineChangesNext = [];
  (globalThis as unknown as { __monaco: ReturnType<typeof makeStubMonaco> }).__monaco =
    makeStubMonaco();
  modelRegistry.notifyMonacoReady(
    (globalThis as unknown as { __monaco: Parameters<typeof modelRegistry.notifyMonacoReady>[0] })
      .__monaco,
  );
  modelRegistry._resetForTests();
});

afterEach(() => {
  cleanup();
  modelRegistry._resetForTests();
});

describe("StickyDiffEditor", () => {
  it("mounts a diff editor and exposes the mount slot", () => {
    const { getByTestId } = render(() => (
      <StickyDiffEditor
        originalUri="git://repo/src/x.ts/HEAD"
        modifiedUri="disk:///repo/src/x.ts"
      />
    ));
    expect(getByTestId("sticky-diff-editor")).toBeInTheDocument();
    expect(getByTestId("sticky-diff-editor-mount")).toBeInTheDocument();
    expect(lastEditor).not.toBeNull();
  });

  it("does not render the hunk list when no accept/reject handlers are supplied", () => {
    const { queryByTestId } = render(() => (
      <StickyDiffEditor
        originalUri="git://repo/src/x.ts/HEAD"
        modifiedUri="disk:///repo/src/x.ts"
      />
    ));
    // Even if hunks arrive, no UI surface because no callbacks.
    lineChangesNext = [
      {
        originalStartLineNumber: 10,
        originalEndLineNumber: 12,
        modifiedStartLineNumber: 10,
        modifiedEndLineNumber: 14,
      },
    ];
    for (const cb of updateDiffListeners) cb();
    expect(queryByTestId("sticky-diff-hunk-list")).toBeNull();
  });

  it("fires per-hunk Accept / Reject callbacks with the line ranges", () => {
    const accepts: DiffHunk[] = [];
    const rejects: DiffHunk[] = [];
    const { getAllByTestId, getByTestId } = render(() => (
      <StickyDiffEditor
        originalUri="git://repo/src/x.ts/HEAD"
        modifiedUri="file:///repo/src/x.ts"
        onAcceptHunk={(h) => accepts.push(h)}
        onRejectHunk={(h) => rejects.push(h)}
      />
    ));

    lineChangesNext = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 5,
      },
      {
        originalStartLineNumber: 20,
        originalEndLineNumber: 20,
        modifiedStartLineNumber: 22,
        modifiedEndLineNumber: 22,
      },
    ];
    for (const cb of updateDiffListeners) cb();

    expect(getByTestId("sticky-diff-hunk-list")).toBeInTheDocument();
    const items = getAllByTestId("sticky-diff-hunk-item");
    expect(items).toHaveLength(2);

    const acceptBtns = getAllByTestId("sticky-diff-hunk-accept");
    const rejectBtns = getAllByTestId("sticky-diff-hunk-reject");
    fireEvent.click(acceptBtns[0]!);
    fireEvent.click(rejectBtns[1]!);

    expect(accepts).toEqual([
      {
        originalStartLine: 1,
        originalEndLine: 3,
        modifiedStartLine: 1,
        modifiedEndLine: 5,
      },
    ]);
    expect(rejects).toEqual([
      {
        originalStartLine: 20,
        originalEndLine: 20,
        modifiedStartLine: 22,
        modifiedEndLine: 22,
      },
    ]);
  });
});
