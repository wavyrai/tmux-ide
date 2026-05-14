/**
 * MonacoModelRegistry — register disk → status flips to ready.
 *
 * Monaco itself is stubbed at the module level: we only need a
 * minimal `editor.createModel` / `editor.getModel` / `Uri.parse`
 * surface, and a single `dispose()`. The fetch RPC is mocked via the
 * `@/lib/api` module mock so the test runs hermetically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

let nextModelId = 0;
type StubModel = {
  _id: number;
  _value: string;
  _uri: string;
  dispose: () => void;
  disposed: boolean;
  getValue: () => string;
};
const stubModels = new Map<string, StubModel>();

const stubMonaco = {
  Uri: { parse: (s: string) => ({ toString: () => s, _raw: s }) },
  editor: {
    getModel: (uri: { _raw: string }) => stubModels.get(uri._raw),
    createModel: (value: string, _language: string, uri: { _raw: string }) => {
      const model: StubModel = {
        _id: nextModelId++,
        _value: value,
        _uri: uri._raw,
        disposed: false,
        getValue() {
          return this._value;
        },
        dispose() {
          this.disposed = true;
          stubModels.delete(uri._raw);
        },
      };
      stubModels.set(uri._raw, model);
      return model;
    },
  },
};

vi.mock("@/lib/api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...orig,
    fetchFilePreview: vi.fn((_session: string, filePath: string) =>
      Effect.succeed({
        file: filePath,
        exists: true,
        content: `// content of ${filePath}\n`,
      }),
    ),
  };
});

import { modelRegistry } from "@/lib/monaco/model-registry";
import { fetchFilePreview } from "@/lib/api";

beforeEach(() => {
  // Stash the stub monaco onto globalThis the same way the pool does.
  (globalThis as unknown as { __monaco: typeof stubMonaco }).__monaco = stubMonaco;
  modelRegistry.notifyMonacoReady(
    stubMonaco as unknown as Parameters<typeof modelRegistry.notifyMonacoReady>[0],
  );
  modelRegistry._resetForTests();
  stubModels.clear();
  nextModelId = 0;
  vi.mocked(fetchFilePreview).mockClear();
});

afterEach(() => {
  modelRegistry._resetForTests();
});

describe("MonacoModelRegistry", () => {
  it("disk registration flips modelStatus to 'ready' and creates a model", async () => {
    const bufferUri = await Effect.runPromise(
      modelRegistry.registerDisk({
        sessionName: "smoke",
        rootPath: "/repo",
        filePath: "src/index.ts",
        language: "typescript",
      }),
    );
    expect(bufferUri).toBe("file:///repo/src/index.ts");
    expect(modelRegistry.modelStatus("disk:///repo/src/index.ts")).toBe("ready");
    const model = modelRegistry.getModelByUri("disk:///repo/src/index.ts");
    expect(model).toBeDefined();
    expect(modelRegistry.getValue("disk:///repo/src/index.ts")).toBe(
      "// content of src/index.ts\n",
    );
  });

  it("dedups concurrent registrations of the same file", async () => {
    const [a, b] = await Promise.all([
      Effect.runPromise(
        modelRegistry.registerDisk({
          sessionName: "smoke",
          rootPath: "/repo",
          filePath: "src/dup.ts",
          language: "typescript",
        }),
      ),
      Effect.runPromise(
        modelRegistry.registerDisk({
          sessionName: "smoke",
          rootPath: "/repo",
          filePath: "src/dup.ts",
          language: "typescript",
        }),
      ),
    ]);
    expect(a).toBe(b);
    // Only one fetch should have been issued.
    expect(vi.mocked(fetchFilePreview).mock.calls.length).toBe(1);
  });

  it("unregister drops the ref count; eviction disposes the model", async () => {
    const bufferUri = await Effect.runPromise(
      modelRegistry.registerDisk({
        sessionName: "smoke",
        rootPath: "/repo",
        filePath: "src/dispose.ts",
        language: "typescript",
      }),
    );
    const diskUri = bufferUri.replace("file://", "disk://");
    const model = modelRegistry.getModelByUri(diskUri) as unknown as StubModel;
    expect(model.disposed).toBe(false);
    modelRegistry.unregisterModel(diskUri);
    // Force-eviction (instead of waiting 60s).
    modelRegistry.evictNow(diskUri);
    expect(model.disposed).toBe(true);
    expect(modelRegistry.getModelByUri(diskUri)).toBeUndefined();
  });

  it("status flips to 'error' when the fetch reports a missing file", async () => {
    vi.mocked(fetchFilePreview).mockReturnValueOnce(
      Effect.succeed({ file: "src/missing.ts", exists: false, content: "" }),
    );
    await expect(
      Effect.runPromise(
        modelRegistry.registerDisk({
          sessionName: "smoke",
          rootPath: "/repo",
          filePath: "src/missing.ts",
          language: "typescript",
        }),
      ),
    ).rejects.toBeDefined();
    expect(modelRegistry.modelStatus("disk:///repo/src/missing.ts")).toBe("error");
  });
});
