import { AppWindowDocumentV1SchemaZ } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import { initialApplicationShellAppWindows } from "../application-shell-app-windows.ts";

const NOW = "2026-07-22T10:00:00.000Z";

describe("initialApplicationShellAppWindows", () => {
  it("creates one deterministic visible dock leaf per terminal and preserves semantic focus", () => {
    const sourceIds = Array.from({ length: 17 }, (_, index) => `terminal.agent.${index}`);
    const first = initialApplicationShellAppWindows(sourceIds, sourceIds[11]!, NOW);
    const second = initialApplicationShellAppWindows(sourceIds, sourceIds[11]!, NOW);

    expect(first).toEqual(second);
    expect(AppWindowDocumentV1SchemaZ.parse(first)).toEqual(first);
    expect(Object.values(first.windows)).toHaveLength(17);
    expect(Object.values(first.windows).map(({ source }) => source)).toEqual(
      sourceIds.map((terminalSourceId) => ({ kind: "terminal", terminalSourceId })),
    );
    expect(first.windows[first.focusedWindowId!]?.source).toEqual({
      kind: "terminal",
      terminalSourceId: sourceIds[11],
    });
    expect(first.dockRoot).toMatchObject({ type: "split", axis: "vertical" });
  });

  it("deduplicates discovery and keeps an empty first-run scene valid", () => {
    const duplicate = initialApplicationShellAppWindows(
      ["terminal.lead", "terminal.lead"],
      "terminal.lead",
      NOW,
    );
    expect(Object.values(duplicate.windows)).toHaveLength(1);
    expect(duplicate.dockRoot).toMatchObject({ type: "stack" });

    const empty = initialApplicationShellAppWindows([], null, NOW);
    expect(empty.dockRoot).toBeNull();
    expect(empty.focusedWindowId).toBeNull();
    expect(AppWindowDocumentV1SchemaZ.safeParse(empty).success).toBe(true);
  });
});
