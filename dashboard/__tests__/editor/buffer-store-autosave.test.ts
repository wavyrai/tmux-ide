/**
 * G17-P6 buffer-store additions — autosave debounce, crash
 * recovery, external-change reseed.
 *
 * Monaco + saveFile are stubbed at the module level. The autosave
 * window is exposed via `_getAutosaveWindowMsForTests` so we can
 * tick `vi.useFakeTimers()` past it deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  acceptExternalChange,
  bufferState,
  closeBuffer,
  discardRecoverableBuffer,
  dismissExternalChange,
  listRecoverableBuffers,
  markContent,
  markReady,
  openBuffer,
  reseedFromExternal,
  restoreRecoverableBuffer,
  save,
} from "@/lib/editor/buffer-store";
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
  mockSaveFile.mockReturnValue(Effect.succeed({ ok: true, path: "x.ts", bytes: 0 }));
});

afterEach(() => {
  vi.useRealTimers();
  __resetBufferStoreForTests();
  modelRegistry._resetForTests();
});

function openReady(filePath: string, content = "base") {
  const { bufferUri } = openBuffer({
    sessionName: "smoke",
    rootPath: "/repo",
    filePath,
    language: "typescript",
  });
  markReady(bufferUri, content);
  return bufferUri;
}

describe("autosave debounce", () => {
  it("schedules a save after the configured window", async () => {
    vi.useFakeTimers();
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    expect(_hasPendingAutosaveForTests(uri)).toBe(true);
    expect(mockSaveFile).not.toHaveBeenCalled();
    // Tick past the autosave window. `save` is async; advance both
    // timers + microtasks so the mock's success path resolves.
    await vi.advanceTimersByTimeAsync(_getAutosaveWindowMsForTests() + 50);
    expect(mockSaveFile).toHaveBeenCalledWith("smoke", "src/x.ts", "v1\n");
    expect(bufferState.buffers[uri]?.dirty).toBe(false);
    expect(_hasPendingAutosaveForTests(uri)).toBe(false);
  });

  it("debounces consecutive edits — only the latest content saves", async () => {
    vi.useFakeTimers();
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    await vi.advanceTimersByTimeAsync(_getAutosaveWindowMsForTests() / 2);
    markContent(uri, "v2\n");
    await vi.advanceTimersByTimeAsync(_getAutosaveWindowMsForTests() + 50);
    expect(mockSaveFile).toHaveBeenCalledTimes(1);
    expect(mockSaveFile).toHaveBeenCalledWith("smoke", "src/x.ts", "v2\n");
  });

  it("cancels the autosave when content returns to baseContent before the window fires", async () => {
    vi.useFakeTimers();
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    markContent(uri, "v0\n");
    expect(_hasPendingAutosaveForTests(uri)).toBe(false);
    await vi.advanceTimersByTimeAsync(_getAutosaveWindowMsForTests() + 50);
    expect(mockSaveFile).not.toHaveBeenCalled();
  });

  it("explicit save cancels the autosave timer", async () => {
    vi.useFakeTimers();
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    expect(_hasPendingAutosaveForTests(uri)).toBe(true);
    await save(uri);
    expect(_hasPendingAutosaveForTests(uri)).toBe(false);
    await vi.advanceTimersByTimeAsync(_getAutosaveWindowMsForTests() + 50);
    expect(mockSaveFile).toHaveBeenCalledTimes(1);
  });

  it("closing a dirty buffer with discardDirty clears the autosave", async () => {
    vi.useFakeTimers();
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    closeBuffer(uri, { discardDirty: true });
    expect(_hasPendingAutosaveForTests(uri)).toBe(false);
    await vi.advanceTimersByTimeAsync(_getAutosaveWindowMsForTests() + 50);
    expect(mockSaveFile).not.toHaveBeenCalled();
  });
});

describe("crash recovery persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists a snapshot to localStorage on dirty edit", () => {
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    const snaps = listRecoverableBuffers("smoke");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.filePath).toBe("src/x.ts");
    expect(snaps[0]?.content).toBe("v1\n");
    expect(snaps[0]?.baseContent).toBe("v0\n");
  });

  it("clears the snapshot once dirty content reverts to base", () => {
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    expect(listRecoverableBuffers("smoke")).toHaveLength(1);
    markContent(uri, "v0\n");
    expect(listRecoverableBuffers("smoke")).toHaveLength(0);
  });

  it("clears the snapshot after a successful save", async () => {
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    await save(uri);
    expect(listRecoverableBuffers("smoke")).toHaveLength(0);
  });

  it("keeps the snapshot when save fails", async () => {
    mockSaveFile.mockReturnValue(Effect.fail(new Error("disk full")));
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    await save(uri);
    expect(listRecoverableBuffers("smoke")).toHaveLength(1);
  });

  it("listRecoverableBuffers filters by sessionName", () => {
    const a = openBuffer({
      sessionName: "alpha",
      rootPath: "/a",
      filePath: "x.ts",
      language: "typescript",
    });
    markReady(a.bufferUri, "v0\n");
    markContent(a.bufferUri, "v1\n");
    const b = openBuffer({
      sessionName: "beta",
      rootPath: "/b",
      filePath: "y.ts",
      language: "typescript",
    });
    markReady(b.bufferUri, "z0\n");
    markContent(b.bufferUri, "z1\n");
    expect(listRecoverableBuffers("alpha")).toHaveLength(1);
    expect(listRecoverableBuffers("beta")).toHaveLength(1);
    expect(listRecoverableBuffers()).toHaveLength(2);
  });

  it("restoreRecoverableBuffer rehydrates content + dirty state", async () => {
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "edited\n");
    const snap = listRecoverableBuffers("smoke")[0]!;
    // Simulate a "restart" — reset in-memory state but keep
    // localStorage.
    __resetBufferStoreForTests();
    window.localStorage.setItem(
      "tmux-ide.editor.recovery.v1",
      JSON.stringify({ [snap.bufferUri]: snap }),
    );
    // restoreRecoverableBuffer awaits markReady before reapplying the
    // dirty edits, so the caller must await it too.
    await restoreRecoverableBuffer(snap);
    const buf = bufferState.buffers[snap.bufferUri]!;
    expect(buf.status).toBe("ready");
    expect(buf.content).toBe("edited\n");
    expect(buf.baseContent).toBe("v0\n");
    expect(buf.dirty).toBe(true);
  });

  it("discardRecoverableBuffer drops the snapshot without opening", () => {
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "v1\n");
    const snap = listRecoverableBuffers("smoke")[0]!;
    __resetBufferStoreForTests();
    window.localStorage.setItem(
      "tmux-ide.editor.recovery.v1",
      JSON.stringify({ [snap.bufferUri]: snap }),
    );
    discardRecoverableBuffer(snap.bufferUri);
    expect(listRecoverableBuffers("smoke")).toHaveLength(0);
    expect(bufferState.buffers[snap.bufferUri]).toBeUndefined();
  });
});

describe("reseedFromExternal", () => {
  it("silently re-syncs a clean buffer + bumps the Monaco model", () => {
    const uri = openReady("src/x.ts", "v0\n");
    reseedFromExternal(uri, "v1-from-disk\n");
    const buf = bufferState.buffers[uri]!;
    expect(buf.content).toBe("v1-from-disk\n");
    expect(buf.baseContent).toBe("v1-from-disk\n");
    expect(buf.dirty).toBe(false);
    expect(buf.externalContent).toBeNull();
    expect(modelRegistry.getValue(uri)).toBe("v1-from-disk\n");
  });

  it("parks the new content in externalContent when the buffer is dirty", () => {
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "user-edit\n");
    reseedFromExternal(uri, "external-write\n");
    const buf = bufferState.buffers[uri]!;
    expect(buf.dirty).toBe(true);
    expect(buf.content).toBe("user-edit\n"); // not touched
    expect(buf.externalContent).toBe("external-write\n");
  });

  it("acceptExternalChange replaces buffer content with the external version", () => {
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "user-edit\n");
    reseedFromExternal(uri, "external-write\n");
    acceptExternalChange(uri);
    const buf = bufferState.buffers[uri]!;
    expect(buf.content).toBe("external-write\n");
    expect(buf.baseContent).toBe("external-write\n");
    expect(buf.dirty).toBe(false);
    expect(buf.externalContent).toBeNull();
  });

  it("dismissExternalChange drops the banner without touching user content", () => {
    const uri = openReady("src/x.ts", "v0\n");
    markContent(uri, "user-edit\n");
    reseedFromExternal(uri, "external-write\n");
    dismissExternalChange(uri);
    const buf = bufferState.buffers[uri]!;
    expect(buf.content).toBe("user-edit\n");
    expect(buf.dirty).toBe(true);
    expect(buf.externalContent).toBeNull();
  });

  it("is idempotent when the external content equals baseContent", () => {
    const uri = openReady("src/x.ts", "v0\n");
    reseedFromExternal(uri, "v0\n");
    expect(bufferState.buffers[uri]?.externalContent).toBeNull();
    expect(bufferState.buffers[uri]?.content).toBe("v0\n");
  });
});
