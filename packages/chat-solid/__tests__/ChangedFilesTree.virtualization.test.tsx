/**
 * Contracts test for the virtualized ChangedFilesTree.
 *
 * Seeds a 1000-file changeset and asserts only a viewport-sized
 * window of file rows lands in the DOM while the virtualizer's
 * spacer reports >20000px of virtual content.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChangedFilesTree } from "../src/components/ChangedFilesTree";
import type { ChangedFile } from "../src/lib/changedFiles";

function file(i: number): ChangedFile {
  return {
    path: `src/dir-${i % 50}/file-${i.toString().padStart(4, "0")}.ts`,
    kind: "write",
    edits: [],
    totalAdditions: 1,
    totalDeletions: 0,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ChangedFilesTree virtualization", () => {
  it("renders only a viewport-sized window of file rows for 1000 files", () => {
    const files = Array.from({ length: 1000 }, (_, i) => file(i));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [accessor] = createSignal<ChangedFile[]>(files);
    const dispose = render(() => <ChangedFilesTree files={accessor} />, container);

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='changed-files-tree-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 1000 files × ~32px + 50 dir headers × ~20px ≈ 33000px.
    expect(h).toBeGreaterThan(20_000);

    dispose();
  });
});
