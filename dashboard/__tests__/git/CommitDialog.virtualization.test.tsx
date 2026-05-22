/**
 * Contracts test for the virtualized CommitDialog file picker.
 *
 * A 1000-file changeset must render only a viewport-sized window of
 * checkbox rows; the spacer reports the full virtual height.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import type { GitChange } from "@tmux-ide/contracts";
import { CommitDialog } from "@/components/CommitDialog";

afterEach(() => {
  cleanup();
});

describe("CommitDialog virtualization", () => {
  it("renders only a viewport-sized window of rows for 1000 changed files", () => {
    const unstaged: GitChange[] = Array.from({ length: 1000 }, (_, i) => ({
      path: `src/file-${i.toString().padStart(4, "0")}.ts`,
      status: "modified",
      additions: 0,
      deletions: 0,
    }));

    const { container } = render(() => (
      <CommitDialog
        sessionName="proj"
        open={true}
        staged={[]}
        unstaged={unstaged}
        onClose={() => undefined}
        onCommitted={() => undefined}
      />
    ));

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='commit-dialog-files-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 1000 × at least 28px = 28000px.
    expect(h).toBeGreaterThan(25_000);
  });
});
