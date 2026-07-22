/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { WorkspaceFilesSurface, type FilesSurfaceProps } from "./workspace-files-surface.tsx";
import {
  FILES_SELECTED_ID,
  FILES_SRC_ID,
  createFilesEmptyModel,
  createFilesPreviewBinary,
  createFilesPreviewReady,
  createFilesPreviewTruncated,
  createFilesPreviewUnavailable,
  createFilesReadyModel,
  createFilesTruncatedModel,
  createFilesUnavailableModel,
} from "./workspace-files-fixture.ts";

const NODE_MODULES_ID = "file.node_modules0000000";

function mount(props: FilesSurfaceProps = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => <WorkspaceFilesSurface {...props} />, root);
  return { root, dispose };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("workspace files surface", () => {
  it("renders the explorer tree, selection, git markers, and a directory loading affordance", () => {
    const { root } = mount({ model: createFilesReadyModel() });
    const rows = root.querySelectorAll<HTMLButtonElement>('[role="treeitem"]');
    expect(rows.length).toBe(7);

    const selected = [...rows].find((row) => row.getAttribute("aria-selected") === "true");
    expect(selected?.dataset.id).toBe(FILES_SELECTED_ID);
    expect(selected?.tabIndex).toBe(0);

    expect(root.querySelector('[data-status="added"]')?.textContent).toBe("A");
    expect(root.querySelector('[data-status="modified"]')?.textContent).toBe("M");
    expect(root.querySelector('[data-ignored="true"]')).not.toBeNull();
    expect(root.querySelector('[data-hidden="true"]')).not.toBeNull();
    // components is expanded but its catalog is not loaded yet.
    expect(root.querySelector(".workspace-files__row-loading")?.textContent).toContain("Loading");
  });

  it("reports selection on click and directory toggles on chevron activation", () => {
    const onSelectFile = vi.fn();
    const onToggleDirectory = vi.fn();
    const { root } = mount({
      model: createFilesReadyModel(),
      onSelectFile,
      onToggleDirectory,
    });
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    const readme = rows.find((row) => row.textContent?.includes("README.md"));
    readme?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelectFile).toHaveBeenCalledWith("file.readme000000000000");

    const nodeModules = rows.find((row) => row.dataset.id === NODE_MODULES_ID);
    const twist = nodeModules?.querySelector<HTMLElement>(".workspace-files__twist");
    twist?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggleDirectory).toHaveBeenCalledWith(NODE_MODULES_ID, true);
  });

  it("moves focus and drives expand/collapse from the keyboard", () => {
    const onToggleDirectory = vi.fn();
    const { root } = mount({ model: createFilesReadyModel(), onToggleDirectory });
    const tree = root.querySelector<HTMLElement>('[role="tree"]')!;
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];

    rows[0]?.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);

    rows[0]?.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onToggleDirectory).toHaveBeenCalledWith(NODE_MODULES_ID, true);

    const src = rows.find((row) => row.dataset.id === FILES_SRC_ID)!;
    src.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(onToggleDirectory).toHaveBeenCalledWith(FILES_SRC_ID, false);
  });

  it("shows the truncation notice for a bounded tree", () => {
    const { root } = mount({ model: createFilesTruncatedModel() });
    expect(root.querySelector(".workspace-files__bounded")).not.toBeNull();
    expect(root.textContent).toContain("exceeds the bounded explorer view");
  });

  it("renders each preview state honestly", () => {
    const ready = mount({ model: createFilesReadyModel(), preview: createFilesPreviewReady() });
    expect(ready.root.textContent).toContain("export function main");
    expect(ready.root.querySelectorAll(".workspace-files__code li").length).toBe(5);
    ready.dispose();

    const truncated = mount({
      model: createFilesReadyModel(),
      preview: createFilesPreviewTruncated(),
    });
    expect(truncated.root.textContent).toContain("Preview truncated");
    truncated.dispose();

    const binary = mount({ model: createFilesReadyModel(), preview: createFilesPreviewBinary() });
    expect(binary.root.textContent).toContain("Binary file");
    binary.dispose();

    const onRetryPreview = vi.fn();
    const unavailable = mount({
      model: createFilesReadyModel(),
      preview: createFilesPreviewUnavailable(),
      onRetryPreview,
    });
    expect(unavailable.root.textContent).toContain("denied");
    [...unavailable.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Retry preview"))
      ?.click();
    expect(onRetryPreview).toHaveBeenCalledOnce();
    unavailable.dispose();
  });

  it("keeps empty, loading, and unavailable states bounded", () => {
    const empty = mount({ model: createFilesEmptyModel() });
    expect(empty.root.textContent).toContain("directory is empty");
    empty.dispose();

    const loading = mount({ model: { kind: "loading" } });
    expect(loading.root.textContent).toContain("Indexing workspace files");
    loading.dispose();

    const onRetry = vi.fn();
    const unavailable = mount({ model: createFilesUnavailableModel(), onRetry });
    expect(unavailable.root.textContent).toContain("not reachable");
    [...unavailable.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Retry")
      ?.click();
    expect(onRetry).toHaveBeenCalledOnce();
    unavailable.dispose();
  });

  it("defaults to an honest unavailable state without a model", () => {
    const { root } = mount();
    expect(root.querySelector('.workspace-files[data-state="unavailable"]')).not.toBeNull();
    expect(root.textContent).toContain("not available in this build");
  });
});
