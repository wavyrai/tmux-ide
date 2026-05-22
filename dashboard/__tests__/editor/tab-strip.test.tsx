/**
 * TabStrip — render + interaction.
 *
 * Smoke-tests the tab strip drives off `bufferState.order` /
 * `bufferState.activeUri`. Open files via the buffer-store's
 * imperative API + assert: tabs render, dirty `•` shows, close
 * `×` drops the buffer, clicking a tab flips active.
 *
 * Monaco is stubbed so `markReady` can register a writable model
 * without the editor bundle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

vi.mock("@/lib/api", () => ({
  API_BASE: "",
  ApiError: class ApiError extends Error {
    status = 0;
  },
  saveFile: vi.fn(),
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

import { TabStrip } from "@/components/editor/TabStrip";
import {
  __resetBufferStoreForTests,
  bufferState,
  markContent,
  markReady,
  openBuffer,
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
});

afterEach(() => {
  cleanup();
  __resetBufferStoreForTests();
  modelRegistry._resetForTests();
});

describe("TabStrip", () => {
  it("renders one tab per open buffer in open order", () => {
    openBuffer({
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

    const { getAllByTestId } = render(() => <TabStrip />);
    const tabs = getAllByTestId("editor-tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("data-buffer-uri")).toBe("file:///repo/src/a.ts");
    expect(tabs[1]?.getAttribute("data-buffer-uri")).toBe("file:///repo/src/b.ts");
    // Last-opened wins for active.
    expect(tabs[1]?.getAttribute("data-active")).toBe("true");
  });

  it("flips the active tab on click", () => {
    const a = openBuffer({
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

    const { getAllByTestId } = render(() => <TabStrip />);
    const picks = getAllByTestId("editor-tab-pick");
    fireEvent.click(picks[0]!);
    expect(bufferState.activeUri).toBe(a.bufferUri);
  });

  it("renders a dirty dot when the buffer has unsaved edits", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "v0\n");
    markContent(bufferUri, "v1\n");
    const { getByTestId, queryByTestId } = render(() => <TabStrip />);
    expect(getByTestId("editor-tab-dirty-dot")).toBeInTheDocument();
    // After clearing dirty, the dot disappears.
    markContent(bufferUri, "v0\n");
    expect(queryByTestId("editor-tab-dirty-dot")).toBeNull();
  });

  it("closes a clean buffer on × click without confirmation", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "");
    const { getByTestId } = render(() => <TabStrip />);
    fireEvent.click(getByTestId("editor-tab-close"));
    expect(bufferState.buffers[bufferUri]).toBeUndefined();
    expect(bufferState.order).toHaveLength(0);
  });

  it("uses the host's confirm hook for a dirty buffer close", () => {
    const { bufferUri } = openBuffer({
      sessionName: "smoke",
      rootPath: "/repo",
      filePath: "src/x.ts",
      language: "typescript",
    });
    markReady(bufferUri, "v0\n");
    markContent(bufferUri, "v1\n");
    let confirmedFor: string | null = null;
    const { getByTestId } = render(() => (
      <TabStrip
        onConfirmDiscardDirty={(b) => {
          confirmedFor = b.filePath;
          return false; // reject — buffer should remain open
        }}
      />
    ));
    fireEvent.click(getByTestId("editor-tab-close"));
    expect(confirmedFor).toBe("src/x.ts");
    expect(bufferState.buffers[bufferUri]).toBeDefined();
  });
});
