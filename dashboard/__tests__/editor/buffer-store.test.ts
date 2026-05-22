/**
 * Buffer store — open / markContent / save lifecycle tests.
 *
 * The store is module-singleton with a `__resetBufferStoreForTests`
 * hook. Monaco is stubbed so `registerBuffer` can run without the
 * editor bundle; `saveFile` is mocked at the api layer.
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
  fetchProjectDiff: vi.fn(),
}));

// Minimal Monaco stub.
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
  bufferState,
  closeBuffer,
  markContent,
  markError,
  markReady,
  openBuffer,
  save,
  setActiveBuffer,
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
});

afterEach(() => {
  __resetBufferStoreForTests();
  modelRegistry._resetForTests();
});

describe("openBuffer", () => {
  it("inserts a loading entry + sets it active + appends to order", () => {
    const { bufferUri, existed } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/index.ts",
      language: "typescript",
    });
    expect(existed).toBe(false);
    expect(bufferUri).toBe("file:///repo/src/index.ts");
    expect(bufferState.activeUri).toBe(bufferUri);
    expect(bufferState.order).toEqual([bufferUri]);
    expect(bufferState.buffers[bufferUri]?.status).toBe("loading");
    expect(bufferState.buffers[bufferUri]?.dirty).toBe(false);
  });

  it("focuses an already-open buffer without re-inserting", () => {
    const first = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/a.ts",
      language: "typescript",
    });
    openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/b.ts",
      language: "typescript",
    });
    const second = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/a.ts",
      language: "typescript",
    });
    expect(second.existed).toBe(true);
    expect(second.bufferUri).toBe(first.bufferUri);
    expect(bufferState.order).toHaveLength(2);
    expect(bufferState.activeUri).toBe(first.bufferUri);
  });
});

describe("markReady", () => {
  it("seeds the buffer + registers a writable Monaco model", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "const x = 1;\n");
    const buf = bufferState.buffers[bufferUri]!;
    expect(buf.status).toBe("ready");
    expect(buf.content).toBe("const x = 1;\n");
    expect(buf.baseContent).toBe("const x = 1;\n");
    expect(buf.dirty).toBe(false);
    expect(modelRegistry.modelStatus(bufferUri)).toBe("ready");
    expect(modelRegistry.getValue(bufferUri)).toBe("const x = 1;\n");
  });
});

describe("markContent", () => {
  it("flips dirty when content diverges from baseContent + bumps registry dirty bit", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "original\n");
    markContent(bufferUri, "edited\n");
    expect(bufferState.buffers[bufferUri]?.dirty).toBe(true);
    expect(bufferState.buffers[bufferUri]?.content).toBe("edited\n");
    expect(modelRegistry.isDirty(bufferUri)).toBe(true);
  });

  it("clears dirty when content returns to baseContent", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "v0\n");
    markContent(bufferUri, "v1\n");
    expect(modelRegistry.isDirty(bufferUri)).toBe(true);
    markContent(bufferUri, "v0\n");
    expect(bufferState.buffers[bufferUri]?.dirty).toBe(false);
    expect(modelRegistry.isDirty(bufferUri)).toBe(false);
  });

  it("is a no-op when content equals current content", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "v0\n");
    const before = bufferState.buffers[bufferUri]?.content;
    markContent(bufferUri, "v0\n");
    expect(bufferState.buffers[bufferUri]?.content).toBe(before);
  });
});

describe("save", () => {
  it("PUTs content via saveFile, clears dirty, sets lastSavedAt", async () => {
    mockSaveFile.mockReturnValue(Effect.succeed({ ok: true, path: "src/x.ts", bytes: 7 }));
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "before\n");
    markContent(bufferUri, "after\n");
    await save(bufferUri);
    expect(mockSaveFile).toHaveBeenCalledWith("smoke", "src/x.ts", "after\n");
    const buf = bufferState.buffers[bufferUri]!;
    expect(buf.dirty).toBe(false);
    expect(buf.baseContent).toBe("after\n");
    expect(buf.lastSavedAt).not.toBeNull();
    expect(modelRegistry.isDirty(bufferUri)).toBe(false);
  });

  it("captures saveError on failure but keeps dirty true", async () => {
    mockSaveFile.mockReturnValue(Effect.fail(new Error("disk full")));
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "v0\n");
    markContent(bufferUri, "v1\n");
    await save(bufferUri);
    const buf = bufferState.buffers[bufferUri]!;
    expect(buf.dirty).toBe(true);
    expect(buf.saveError).toContain("disk full");
    expect(buf.saving).toBe(false);
  });

  it("is a no-op when nothing is dirty", async () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "v0\n");
    await save(bufferUri);
    expect(mockSaveFile).not.toHaveBeenCalled();
  });
});

describe("closeBuffer", () => {
  it("refuses to close a dirty buffer without discardDirty: true", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "v0\n");
    markContent(bufferUri, "v1\n");
    expect(closeBuffer(bufferUri)).toBe(false);
    expect(bufferState.buffers[bufferUri]).toBeDefined();
    expect(closeBuffer(bufferUri, { discardDirty: true })).toBe(true);
    expect(bufferState.buffers[bufferUri]).toBeUndefined();
    expect(bufferState.order).not.toContain(bufferUri);
  });

  it("drops a clean buffer + shifts activeUri to the previous tab", () => {
    const a = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/a.ts",
      language: "typescript",
    });
    const b = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/b.ts",
      language: "typescript",
    });
    markReady(b.bufferUri, "");
    expect(bufferState.activeUri).toBe(b.bufferUri);
    closeBuffer(b.bufferUri);
    expect(bufferState.activeUri).toBe(a.bufferUri);
    expect(bufferState.order).toEqual([a.bufferUri]);
  });
});

describe("markError + setActiveBuffer", () => {
  it("markError flips status without losing baseContent", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/missing.ts",
      language: "typescript",
    });
    markError(bufferUri, "not found");
    expect(bufferState.buffers[bufferUri]?.status).toBe("error");
    expect(bufferState.buffers[bufferUri]?.saveError).toBe("not found");
  });

  it("setActiveBuffer flips the active pointer", () => {
    const a = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/a.ts",
      language: "typescript",
    });
    const b = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/b.ts",
      language: "typescript",
    });
    setActiveBuffer(a.bufferUri);
    expect(bufferState.activeUri).toBe(a.bufferUri);
    setActiveBuffer(b.bufferUri);
    expect(bufferState.activeUri).toBe(b.bufferUri);
  });
});
