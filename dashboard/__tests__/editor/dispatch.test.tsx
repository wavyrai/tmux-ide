/**
 * `<FileRenderer>` dispatch — covers each kind picks the right
 * Solid renderer + ports an end-to-end markdown render through
 * chat-solid's renderer.
 *
 * Model-registry-backed renderers (markdown, svg) read content via
 * `modelRegistry.getValue(uri)`, so the suite seeds the registry
 * with a stubbed value beforehand. Image / binary / too-large
 * renderers are stateless — they read from the `ManagedFile` prop.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { FileRenderer } from "@/lib/editor/dispatch";
import type { ManagedFile } from "@/lib/editor/types";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { buildMonacoModelPath, toDiskUri } from "@/lib/monaco/model-path";

function makeFile(over: Partial<ManagedFile>): ManagedFile {
  return {
    path: "src/x.ts",
    kind: "text",
    content: "",
    isLoading: false,
    tabId: "tab-1",
    ...over,
  };
}

afterEach(() => cleanup());

describe("FileRenderer dispatch", () => {
  it("text → placeholder (Monaco lands in G17-P4)", () => {
    const { getByTestId } = render(() => (
      <FileRenderer file={makeFile({ path: "src/index.ts", kind: "text" })} modelRootPath="/repo" />
    ));
    expect(getByTestId("editor-text-placeholder")).toBeInTheDocument();
  });

  it("image → ImageRenderer with the data URL", () => {
    const { getByTestId } = render(() => (
      <FileRenderer
        file={makeFile({
          path: "avatars/me.png",
          kind: "image",
          content: "data:image/png;base64,iVBORw0K",
        })}
        modelRootPath="/repo"
      />
    ));
    const root = getByTestId("editor-image-renderer");
    expect(root).toBeInTheDocument();
    const img = root.querySelector("img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.src).toContain("data:image/png");
    expect(img?.alt).toBe("me.png");
  });

  it("binary → BinaryRenderer with file name + extension", () => {
    const { getByTestId } = render(() => (
      <FileRenderer
        file={makeFile({ path: "build/output.wasm", kind: "binary" })}
        modelRootPath="/repo"
      />
    ));
    const root = getByTestId("editor-binary-renderer");
    expect(root.textContent).toContain("output.wasm");
    expect(root.textContent).toContain("WASM file");
    // Fixture supplies no preview bytes, so BinaryRenderer falls back
    // to its no-hex-dump message (the copy now states *why* there's
    // no preview rather than the older generic line).
    expect(root.textContent).toContain("Binary file — file is larger than 64 KB or fetch failed.");
  });

  it("too-large → TooLargeRenderer with formatted size", () => {
    const { getByTestId } = render(() => (
      <FileRenderer
        file={makeFile({
          path: "data/dump.csv",
          kind: "too-large",
          totalSize: 2 * 1024 * 1024,
        })}
        modelRootPath="/repo"
      />
    ));
    const root = getByTestId("editor-too-large-renderer");
    expect(root.textContent).toContain("dump.csv");
    expect(root.textContent).toContain("File too large to display");
    expect(root.textContent).toContain("2.0 MB");
  });
});

describe("MarkdownRenderer (registry-backed)", () => {
  const filePath = "docs/intro.md";
  const modelRootPath = "/repo";
  const bufferUri = buildMonacoModelPath(modelRootPath, filePath);
  const diskUri = toDiskUri(bufferUri);

  beforeEach(() => {
    modelRegistry._resetForTests();
    // Seed the registry's reactive state + a fake model behind the
    // disk URI. We only need `getValue()` — no Monaco instance
    // required.
    const fakeModel = {
      getValue: () => "# Hello\n\nthis is **bold**.",
      dispose: () => {},
    };
    (
      modelRegistry as unknown as {
        modelMap: Map<string, { type: string; model: unknown; refs: number }>;
      }
    ).modelMap.set(diskUri, {
      type: "disk",
      model: fakeModel,
      refs: 1,
    });
  });

  afterEach(() => modelRegistry._resetForTests());

  it("renders the markdown source from the registry into sanitised HTML", () => {
    const { getByTestId } = render(() => (
      <FileRenderer
        file={makeFile({ path: filePath, kind: "markdown" })}
        modelRootPath={modelRootPath}
      />
    ));
    const root = getByTestId("editor-markdown-renderer");
    expect(root.innerHTML).toContain("<h1");
    expect(root.innerHTML).toContain("Hello");
    expect(root.innerHTML).toContain("<strong>bold</strong>");
  });

  it("exposes an Edit-source toggle only when onEditSource is provided", () => {
    let called = "";
    const { getByTestId, queryByTestId } = render(() => (
      <FileRenderer
        file={makeFile({ path: filePath, kind: "markdown" })}
        modelRootPath={modelRootPath}
        onEditSource={(p) => (called = p)}
      />
    ));
    const btn = getByTestId("editor-markdown-toggle-source");
    btn.click();
    expect(called).toBe(filePath);
    expect(queryByTestId("editor-markdown-toggle-preview")).toBeInTheDocument();
  });
});

describe("SvgRenderer (registry-backed)", () => {
  const filePath = "icons/logo.svg";
  const modelRootPath = "/repo";
  const bufferUri = buildMonacoModelPath(modelRootPath, filePath);
  const diskUri = toDiskUri(bufferUri);

  // happy-dom doesn't ship `URL.createObjectURL` — stub it before
  // each test, restore after. The SvgRenderer's whole job is to wrap
  // the SVG source in a Blob URL.
  let createCalls = 0;
  let revokeCalls = 0;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  beforeEach(() => {
    createCalls = 0;
    revokeCalls = 0;
    URL.createObjectURL = ((_blob: Blob) => {
      createCalls += 1;
      return `blob:fake-${createCalls}`;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((_url: string) => {
      revokeCalls += 1;
    }) as typeof URL.revokeObjectURL;
    modelRegistry._resetForTests();
    const fakeModel = {
      getValue: () => "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      dispose: () => {},
    };
    (
      modelRegistry as unknown as {
        modelMap: Map<string, { type: string; model: unknown; refs: number }>;
      }
    ).modelMap.set(diskUri, { type: "disk", model: fakeModel, refs: 1 });
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    modelRegistry._resetForTests();
  });

  it("wraps the SVG source in a Blob URL and renders an <img>", () => {
    const { getByTestId } = render(() => (
      <FileRenderer
        file={makeFile({ path: filePath, kind: "svg" })}
        modelRootPath={modelRootPath}
      />
    ));
    const root = getByTestId("editor-svg-renderer");
    const img = root.querySelector("img") as HTMLImageElement | null;
    expect(img?.src).toContain("blob:fake-1");
    expect(createCalls).toBeGreaterThanOrEqual(1);
  });

  it("revokes the Blob URL on cleanup", () => {
    const { unmount, getByTestId } = render(() => (
      <FileRenderer
        file={makeFile({ path: filePath, kind: "svg" })}
        modelRootPath={modelRootPath}
      />
    ));
    expect(getByTestId("editor-svg-renderer")).toBeInTheDocument();
    unmount();
    expect(revokeCalls).toBeGreaterThanOrEqual(1);
  });
});
