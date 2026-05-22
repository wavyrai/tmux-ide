/**
 * MonacoModelRegistry.registerGit — fetches a git ref via the
 * daemon's `/api/project/:name/git/file` endpoint, creates a
 * read-only model, flips status to `'ready'`.
 *
 * Monaco is stubbed at the module level (same pattern as the disk
 * registry test). `fetchGitFile` is mocked via the `@/lib/api`
 * module mock so the test runs hermetically.
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
    fetchGitFile: vi.fn((_session: string, filePath: string, ref: string) =>
      Effect.succeed({
        path: filePath,
        ref,
        exists: true,
        content: `// ${ref} content of ${filePath}\n`,
      }),
    ),
  };
});

import { modelRegistry } from "@/lib/monaco/model-registry";
import { fetchGitFile } from "@/lib/api";

beforeEach(() => {
  (globalThis as unknown as { __monaco: typeof stubMonaco }).__monaco = stubMonaco;
  modelRegistry.notifyMonacoReady(
    stubMonaco as unknown as Parameters<typeof modelRegistry.notifyMonacoReady>[0],
  );
  modelRegistry._resetForTests();
  stubModels.clear();
  nextModelId = 0;
  vi.mocked(fetchGitFile).mockClear();
});

afterEach(() => {
  modelRegistry._resetForTests();
});

describe("MonacoModelRegistry.registerGit", () => {
  it("returns the git URI and flips status to 'ready'", async () => {
    const gitUri = await Effect.runPromise(
      modelRegistry.registerGit({
        sessionName: "smoke",
        rootPath: "/repo",
        filePath: "src/x.ts",
        language: "typescript",
        ref: "HEAD",
      }),
    );
    expect(gitUri).toBe("git://repo/src/x.ts/HEAD");
    expect(modelRegistry.modelStatus(gitUri)).toBe("ready");
    expect(modelRegistry.getValue(gitUri)).toBe("// HEAD content of src/x.ts\n");
  });

  it("dedups concurrent registrations for the same ref", async () => {
    const [a, b] = await Promise.all([
      Effect.runPromise(
        modelRegistry.registerGit({
          sessionName: "smoke",
          rootPath: "/repo",
          filePath: "src/dup.ts",
          language: "typescript",
          ref: "HEAD",
        }),
      ),
      Effect.runPromise(
        modelRegistry.registerGit({
          sessionName: "smoke",
          rootPath: "/repo",
          filePath: "src/dup.ts",
          language: "typescript",
          ref: "HEAD",
        }),
      ),
    ]);
    expect(a).toBe(b);
    expect(vi.mocked(fetchGitFile).mock.calls.length).toBe(1);
  });

  it("creates a distinct model for a different ref on the same file", async () => {
    const head = await Effect.runPromise(
      modelRegistry.registerGit({
        sessionName: "smoke",
        rootPath: "/repo",
        filePath: "src/x.ts",
        language: "typescript",
        ref: "HEAD",
      }),
    );
    const staged = await Effect.runPromise(
      modelRegistry.registerGit({
        sessionName: "smoke",
        rootPath: "/repo",
        filePath: "src/x.ts",
        language: "typescript",
        ref: "STAGED",
      }),
    );
    expect(head).not.toBe(staged);
    expect(modelRegistry.modelStatus(head)).toBe("ready");
    expect(modelRegistry.modelStatus(staged)).toBe("ready");
  });

  it("renders empty content when the file didn't exist at the ref", async () => {
    vi.mocked(fetchGitFile).mockReturnValueOnce(
      Effect.succeed({ path: "src/new.ts", ref: "HEAD", exists: false, content: "" }),
    );
    const gitUri = await Effect.runPromise(
      modelRegistry.registerGit({
        sessionName: "smoke",
        rootPath: "/repo",
        filePath: "src/new.ts",
        language: "typescript",
        ref: "HEAD",
      }),
    );
    expect(modelRegistry.modelStatus(gitUri)).toBe("ready");
    expect(modelRegistry.getValue(gitUri)).toBe("");
  });
});
