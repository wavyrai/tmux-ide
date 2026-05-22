/**
 * Tests for the open-at-line broker (G19-P3).
 *
 * Covers:
 *   - pendingReveal lifecycle: set / consume by URI / no-match drain.
 *   - openFileAt: openBuffer + fetchFilePreview + markReady flow, +
 *     pending-reveal published with the right column/length.
 *   - bufferUriFor: pure helper round-trips through the
 *     model-path builder.
 *
 * Stays clear of the Monaco runtime — we stub the registry's
 * `registerBuffer` so `markReady` doesn't try to spin up an
 * IStandaloneCodeEditor inside happy-dom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { __resetBufferStoreForTests, bufferState } from "@/lib/editor/buffer-store";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { codeEditorPool } from "@/lib/monaco/code-pool";
import {
  __resetPendingRevealForTests,
  bufferUriFor,
  consumeReveal,
  openFileAt,
  pendingRevealSignal,
  setPendingReveal,
} from "@/lib/editorOpen";

let originalFetch: typeof globalThis.fetch | undefined;
let registerBufferSpy: ReturnType<typeof vi.spyOn>;
let poolInitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetBufferStoreForTests();
  __resetPendingRevealForTests();
  registerBufferSpy = vi
    .spyOn(modelRegistry, "registerBuffer")
    .mockImplementation((_input: unknown) => {
      // No-op — markReady only cares that this didn't throw. The
      // real signature returns the buffer URI; an empty string is
      // an acceptable stand-in for callers that don't inspect it.
      return "";
    });
  // markReady warms the editor pool when Monaco isn't already on the
  // global; the real `@monaco-editor/loader` can't run under
  // happy-dom, so resolve it to a no-op (same intent as the
  // registerBuffer stub above).
  poolInitSpy = vi.spyOn(codeEditorPool, "init").mockResolvedValue(undefined);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  __resetBufferStoreForTests();
  __resetPendingRevealForTests();
  registerBufferSpy.mockRestore();
  poolInitSpy.mockRestore();
  if (originalFetch !== undefined) globalThis.fetch = originalFetch;
});

function withRoot<T>(fn: () => T): T {
  return createRoot((dispose) => {
    try {
      return fn();
    } finally {
      dispose();
    }
  });
}

describe("pendingReveal lifecycle", () => {
  it("publishes + reads a reveal request", () => {
    setPendingReveal({
      bufferUri: "file:///root/a.ts",
      filePath: "a.ts",
      line: 12,
      column: 3,
      length: 4,
    });
    expect(pendingRevealSignal()).toEqual({
      bufferUri: "file:///root/a.ts",
      filePath: "a.ts",
      line: 12,
      column: 3,
      length: 4,
    });
  });

  it("consumeReveal drains the signal when the URI matches", () => {
    setPendingReveal({ bufferUri: "file:///root/a.ts", filePath: "a.ts", line: 5 });
    const out = consumeReveal("file:///root/a.ts");
    expect(out).toEqual({ bufferUri: "file:///root/a.ts", filePath: "a.ts", line: 5 });
    expect(pendingRevealSignal()).toBeNull();
  });

  it("consumeReveal returns null + leaves the signal alone when the URI doesn't match", () => {
    setPendingReveal({ bufferUri: "file:///root/a.ts", filePath: "a.ts", line: 5 });
    expect(consumeReveal("file:///root/b.ts")).toBeNull();
    expect(pendingRevealSignal()).not.toBeNull();
  });

  it("consumeReveal returns null when nothing is queued", () => {
    expect(consumeReveal("file:///anywhere")).toBeNull();
  });

  it("setPendingReveal replaces any prior unconsumed entry", () => {
    setPendingReveal({ bufferUri: "file:///a", filePath: "a", line: 1 });
    setPendingReveal({ bufferUri: "file:///b", filePath: "b", line: 2 });
    expect(pendingRevealSignal()?.filePath).toBe("b");
  });
});

describe("bufferUriFor", () => {
  it("matches the model-path builder both sides use", () => {
    const uri = bufferUriFor("/", "src/foo.ts");
    expect(uri.startsWith("file://")).toBe(true);
    expect(uri.endsWith("/src/foo.ts")).toBe(true);
  });
});

describe("openFileAt", () => {
  function mockPreviewOk(content: string): void {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ file: "src/a.ts", exists: true, content }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  it("opens a buffer + queues a pending reveal with column + length", async () => {
    mockPreviewOk("TODO: hello");
    await withRoot(async () => {
      const { bufferUri, existed } = openFileAt({
        sessionName: "demo",
        rootPath: "/",
        filePath: "src/a.ts",
        language: "typescript",
        line: 1,
        column: 0,
        length: 4,
      });
      expect(existed).toBe(false);
      expect(bufferState.activeUri).toBe(bufferUri);
      expect(bufferState.buffers[bufferUri]?.status).toBe("loading");
      const reveal = pendingRevealSignal();
      expect(reveal).toEqual({
        bufferUri,
        filePath: "src/a.ts",
        line: 1,
        column: 0,
        length: 4,
      });

      // Pump the microtask queue until the fetch + markReady fires.
      const deadline = Date.now() + 200;
      while (bufferState.buffers[bufferUri]?.status === "loading" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(bufferState.buffers[bufferUri]?.status).toBe("ready");
      expect(bufferState.buffers[bufferUri]?.content).toBe("TODO: hello");
    });
  });

  it("refreshes pending-reveal on re-open without re-fetching content", async () => {
    mockPreviewOk("x");
    await withRoot(async () => {
      const first = openFileAt({
        sessionName: "demo",
        rootPath: "/",
        filePath: "a.ts",
        language: "typescript",
        line: 1,
      });
      // Wait for first fetch to settle.
      const deadline = Date.now() + 200;
      while (bufferState.buffers[first.bufferUri]?.status === "loading" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const fetchCallsAfterFirst = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

      const second = openFileAt({
        sessionName: "demo",
        rootPath: "/",
        filePath: "a.ts",
        language: "typescript",
        line: 42,
        column: 7,
        length: 3,
      });
      expect(second.bufferUri).toBe(first.bufferUri);
      expect(second.existed).toBe(true);

      // No additional fetch — buffer already in the store.
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        fetchCallsAfterFirst,
      );
      // But the pending-reveal moved to the new line.
      expect(pendingRevealSignal()).toEqual({
        bufferUri: first.bufferUri,
        filePath: "a.ts",
        line: 42,
        column: 7,
        length: 3,
      });
    });
  });
});
