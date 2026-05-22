import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { ChangedFilesTree } from "../src/components/ChangedFilesTree";
import type { ChangedFile } from "../src/lib/changedFiles";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ChangedFilesTree", () => {
  it("renders files and expands inline diff content", () => {
    const [files] = createSignal<ChangedFile[]>([
      {
        path: "src/components/ChatComposer.tsx",
        kind: "write",
        edits: [
          {
            oldText: "old line\n",
            newText: "new line\nanother line\n",
            toolCallId: "tool-1",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        totalAdditions: 2,
        totalDeletions: 1,
      },
      {
        path: "README.md",
        kind: "read",
        edits: [],
        totalAdditions: 0,
        totalDeletions: 0,
      },
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <ChangedFilesTree files={files} />, container);

    expect(container.textContent).toContain("Changed files");
    expect(container.textContent).toContain("ChatComposer.tsx");
    expect(container.textContent).toContain("+2");
    // DiffStatLabel uses the typographic minus sign (U+2212) for
    // visual parity with the upstream surface, not the ASCII hyphen.
    expect(container.textContent).toContain("−1");
    expect(container.textContent).not.toContain("new line");

    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("ChatComposer.tsx"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(container.textContent).toContain("+new line");
    expect(container.textContent).toContain("-old line");
  });
});
