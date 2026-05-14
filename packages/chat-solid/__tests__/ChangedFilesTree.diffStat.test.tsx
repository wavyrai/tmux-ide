/**
 * Polish coverage for ChangedFilesTree: the new DiffStatLabel is
 * surfaced per file row, and an `onOpenDiff` prop routes the row
 * click to a host-supplied diff viewer entry point.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChangedFilesTree } from "../src/components/ChangedFilesTree";
import type { ChangedFile } from "../src/lib/changedFiles";

afterEach(() => {
  document.body.innerHTML = "";
});

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "src/foo.ts",
    kind: "write",
    edits: [
      {
        toolCallId: "tc-1",
        createdAt: "2026-05-14T10:00:00.000Z",
        oldText: "before",
        newText: "after",
      },
    ],
    totalAdditions: 3,
    totalDeletions: 2,
    ...overrides,
  };
}

interface MountOpts {
  files?: ChangedFile[];
  turnId?: string | null;
  onOpenDiff?: (turnId: string | null, path: string) => void;
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [files] = createSignal<ChangedFile[]>(opts.files ?? [file()]);
  const [turnId] = createSignal<string | null>(opts.turnId ?? null);
  const dispose = render(
    () => (
      <ChangedFilesTree
        files={files}
        turnId={() => turnId()}
        onOpenDiff={opts.onOpenDiff}
      />
    ),
    container,
  );
  return { container, dispose };
}

describe("ChangedFilesTree — DiffStatLabel surface", () => {
  it("renders DiffStatLabel per write file when stats are non-zero", () => {
    const { container, dispose } = mount();
    const stats = container.querySelectorAll("[data-testid='diff-stat-label']");
    expect(stats.length).toBe(1);
    expect(stats[0]?.getAttribute("data-additions")).toBe("3");
    expect(stats[0]?.getAttribute("data-deletions")).toBe("2");
    dispose();
  });

  it("uses the 'changed' placeholder when a write file has zero additions and deletions", () => {
    const { container, dispose } = mount({
      files: [file({ totalAdditions: 0, totalDeletions: 0 })],
    });
    expect(container.querySelector("[data-testid='diff-stat-label']")).toBeNull();
    expect(container.textContent).toContain("changed");
    dispose();
  });

  it("shows 'read' for read files instead of a stat", () => {
    const { container, dispose } = mount({
      files: [file({ kind: "read", edits: [], totalAdditions: 0, totalDeletions: 0 })],
    });
    expect(container.querySelector("[data-testid='diff-stat-label']")).toBeNull();
    expect(container.textContent).toContain("read");
    dispose();
  });
});

describe("ChangedFilesTree — diff viewer entry", () => {
  it("clicks the row through to onOpenDiff(turnId, path) when supplied", () => {
    const onOpenDiff = vi.fn();
    const { container, dispose } = mount({
      turnId: "turn-42",
      onOpenDiff,
    });
    container.querySelector<HTMLButtonElement>("[data-testid='changed-files-tree-row']")!.click();
    expect(onOpenDiff).toHaveBeenCalledExactlyOnceWith("turn-42", "src/foo.ts");
    dispose();
  });

  it("exposes the inline expand affordance alongside the row when onOpenDiff is set", () => {
    const { container, dispose } = mount({ onOpenDiff: vi.fn() });
    expect(container.querySelector("[data-testid='changed-files-tree-expand']")).toBeTruthy();
    dispose();
  });

  it("hides the inline expand affordance when no onOpenDiff is wired (legacy mode)", () => {
    const { container, dispose } = mount();
    expect(container.querySelector("[data-testid='changed-files-tree-expand']")).toBeNull();
    dispose();
  });

  it("falls back to inline expand when no onOpenDiff is wired (legacy click)", () => {
    const { container, dispose } = mount();
    const row = container.querySelector<HTMLButtonElement>(
      "[data-testid='changed-files-tree-row']",
    );
    row!.click();
    // After click the inline diff body becomes visible.
    expect(container.textContent).toContain("tc-1");
    dispose();
  });

  it("does not fire onOpenDiff for read files (only writes have diffs)", () => {
    const onOpenDiff = vi.fn();
    const { container, dispose } = mount({
      onOpenDiff,
      files: [file({ kind: "read", edits: [], totalAdditions: 0, totalDeletions: 0 })],
    });
    container.querySelector<HTMLButtonElement>("[data-testid='changed-files-tree-row']")!.click();
    expect(onOpenDiff).not.toHaveBeenCalled();
    dispose();
  });
});
