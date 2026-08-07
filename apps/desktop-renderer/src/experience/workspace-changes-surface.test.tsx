/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { WorkspaceChangesSurface, type ChangesSurfaceProps } from "./workspace-changes-surface.tsx";
import {
  CHANGES_SELECTED_ID,
  createChangesDetachedModel,
  createChangesEmptyModel,
  createChangesNoGitModel,
  createChangesReadyModel,
  createDiffBinaryModel,
  createDiffReadyModel,
  createDiffTruncatedModel,
  createDiffUnavailableModel,
} from "./workspace-changes-fixture.ts";

function mount(props: ChangesSurfaceProps = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const dispose = render(() => <WorkspaceChangesSurface {...props} />, root);
  return { root, dispose };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("workspace changes surface", () => {
  it("renders the branch header, grouped changes, status glyphs, and selection", () => {
    const { root } = mount({ model: createChangesReadyModel() });
    expect(root.querySelector(".workspace-changes__list-region header strong")?.textContent).toBe(
      "main",
    );
    expect(root.textContent).toContain("5 changed");

    const groups = [...root.querySelectorAll(".workspace-changes__group")].map((group) =>
      group.textContent?.replace(/\s+/gu, " ").trim(),
    );
    expect(groups.some((label) => label?.startsWith("Staged"))).toBe(true);
    expect(groups.some((label) => label?.startsWith("Unstaged"))).toBe(true);
    expect(groups.some((label) => label?.startsWith("Untracked"))).toBe(true);

    const options = root.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(options.length).toBe(5);
    const selected = [...options].find((option) => option.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("index.ts");
    expect(selected?.querySelector(".workspace-changes__status")?.textContent).toBe("M");
    expect(root.textContent).toContain("panel.tsx →");
  });

  it("reports selection on click and keyboard navigation", () => {
    const onSelectChange = vi.fn();
    const { root } = mount({ model: createChangesReadyModel(), onSelectChange });
    const options = [...root.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    options.find((option) => option.textContent?.includes("app.tsx"))?.click();
    expect(onSelectChange).toHaveBeenCalledWith("change.unstagedapp000000");

    const list = root.querySelector<HTMLElement>('[role="listbox"]')!;
    options[0]?.focus();
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);
  });

  it("renders the structured diff with hunk header, insert, delete, and truncation", () => {
    const ready = mount({ model: createChangesReadyModel(), diff: createDiffReadyModel() });
    expect(ready.root.querySelector(".workspace-changes__hunk-header")?.textContent).toContain(
      "@@ -1,3 +1,4 @@",
    );
    expect(ready.root.querySelector('.workspace-changes__line[data-kind="insert"]')).not.toBeNull();
    expect(ready.root.querySelector('.workspace-changes__line[data-kind="delete"]')).not.toBeNull();
    ready.dispose();

    const truncated = mount({
      model: createChangesDetachedModel(),
      diff: createDiffTruncatedModel(),
    });
    expect(truncated.root.textContent).toContain("Diff truncated");
    expect(truncated.root.textContent).toContain("Detached HEAD");
    expect(truncated.root.querySelector(".workspace-changes__bounded")).not.toBeNull();
    truncated.dispose();
  });

  it("renders binary and unavailable diff states honestly", () => {
    const binary = mount({ model: createChangesReadyModel(), diff: createDiffBinaryModel() });
    expect(binary.root.textContent).toContain("Binary file changed");
    binary.dispose();

    const onRetryDiff = vi.fn();
    const unavailable = mount({
      model: createChangesReadyModel(),
      diff: createDiffUnavailableModel(),
      onRetryDiff,
    });
    expect(unavailable.root.textContent).toContain("changed while the diff was loading");
    [...unavailable.root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Retry diff"))
      ?.click();
    expect(onRetryDiff).toHaveBeenCalledOnce();
    unavailable.dispose();
  });

  it("keeps empty, loading, and no-git states bounded", () => {
    const empty = mount({ model: createChangesEmptyModel() });
    expect(empty.root.textContent).toContain("working tree is clean");
    empty.dispose();

    const loading = mount({ model: { kind: "loading" } });
    expect(loading.root.textContent).toContain("Reading the working tree");
    loading.dispose();

    const noGit = mount({ model: createChangesNoGitModel() });
    expect(noGit.root.textContent).toContain("not a git repository");
    noGit.dispose();
  });

  it("defaults to an honest unavailable state without a model", () => {
    const { root } = mount();
    expect(root.querySelector('.workspace-changes[data-state="unavailable"]')).not.toBeNull();
    expect(root.textContent).toContain("not available in this build");
  });

  it("keeps the selected change reflected in the diff selection prop", () => {
    const { root } = mount({
      model: createChangesReadyModel(),
      diff: createDiffReadyModel(),
    });
    const selected = [...root.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    expect(selected?.textContent).toContain("index.ts");
    expect(root.querySelector(".workspace-changes__diff-header strong")?.textContent).toBe(
      "src/index.ts",
    );
    expect(CHANGES_SELECTED_ID).toBe("change.stagedindex000000");
  });
});
