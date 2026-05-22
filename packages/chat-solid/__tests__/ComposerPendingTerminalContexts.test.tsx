/**
 * Terminal-context chip strip + inline chip. Covers:
 *
 *   1. The strip renders one chip per context with label
 *      "<terminal> line(s) <range>".
 *   2. Expired contexts (empty text) carry data-expired="true".
 *   3. Optional remove × bubbles to onRemove(id).
 *   4. Strip renders nothing when contexts is empty.
 *   5. The inline-label helpers slug terminal names + handle the
 *      `line N` and `lines M-N` header patterns.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ComposerPendingTerminalContexts } from "../src/components/ComposerPendingTerminalContexts";
import { TerminalContextInlineChip } from "../src/components/TerminalContextInlineChip";
import type { TerminalContextDraft } from "../src/lib/terminalContext";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "../src/lib/userMessageTerminalContexts";

afterEach(() => {
  document.body.innerHTML = "";
});

function draft(overrides: Partial<TerminalContextDraft> = {}): TerminalContextDraft {
  return {
    id: "ctx-1",
    threadId: "thread-1",
    terminalId: "term-1",
    terminalLabel: "Dev Server",
    lineStart: 12,
    lineEnd: 30,
    text: "pnpm dev\nVite dev server running on :5173",
    createdAt: "2026-05-14T08:00:00.000Z",
    ...overrides,
  };
}

function mountStrip(contexts: TerminalContextDraft[], onRemove?: (id: string) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [accessor] = createSignal<ReadonlyArray<TerminalContextDraft>>(contexts);
  const dispose = render(
    () => <ComposerPendingTerminalContexts contexts={accessor} onRemove={onRemove} />,
    container,
  );
  return { container, dispose };
}

describe("ComposerPendingTerminalContexts", () => {
  it("renders nothing for an empty list", () => {
    const { container, dispose } = mountStrip([]);
    expect(
      container.querySelector("[data-testid='composer-pending-terminal-contexts']"),
    ).toBeNull();
    dispose();
  });

  it("renders one chip per context with the formatted label", () => {
    const { container, dispose } = mountStrip([
      draft(),
      draft({ id: "ctx-2", lineStart: 5, lineEnd: 5 }),
    ]);
    const chips = container.querySelectorAll("[data-testid='terminal-context-inline-chip']");
    expect(chips.length).toBe(2);
    expect(chips[0]?.textContent).toContain("Dev Server lines 12-30");
    expect(chips[1]?.textContent).toContain("Dev Server line 5");
    dispose();
  });

  it("flags an expired chip with data-expired='true'", () => {
    const { container, dispose } = mountStrip([draft({ text: "" })]);
    const chip = container.querySelector("[data-testid='terminal-context-inline-chip']");
    expect(chip?.getAttribute("data-expired")).toBe("true");
    dispose();
  });

  it("fires onRemove with the chip id when × is clicked", () => {
    const onRemove = vi.fn();
    const { container, dispose } = mountStrip([draft()], onRemove);
    const removeBtn = container.querySelector<HTMLButtonElement>(
      "[data-testid='terminal-context-inline-chip-remove']",
    );
    expect(removeBtn).toBeTruthy();
    removeBtn!.click();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("ctx-1");
    dispose();
  });

  it("omits the × affordance when no onRemove is supplied", () => {
    const { container, dispose } = mountStrip([draft()]);
    expect(
      container.querySelector("[data-testid='terminal-context-inline-chip-remove']"),
    ).toBeNull();
    dispose();
  });
});

describe("TerminalContextInlineChip (standalone)", () => {
  it("renders the supplied label + tooltip and the expired variant", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => <TerminalContextInlineChip label="dev line 12-30" tooltipText="(expired)" expired />,
      container,
    );
    const chip = container.querySelector("[data-testid='terminal-context-inline-chip']");
    expect(chip?.getAttribute("data-expired")).toBe("true");
    expect(chip?.textContent).toContain("dev line 12-30");
    expect(chip?.getAttribute("title")).toBe("(expired)");
    dispose();
  });
});

describe("userMessageTerminalContexts helpers", () => {
  it("formats `<terminal> lines N-M` headers into a slugged label", () => {
    expect(formatInlineTerminalContextLabel("Dev Server lines 12-30")).toBe("@dev-server:12-30");
  });

  it("formats `<terminal> line N` headers", () => {
    expect(formatInlineTerminalContextLabel("My Shell line 7")).toBe("@my-shell:7");
  });

  it("falls back to a slug when the header is unparseable", () => {
    expect(formatInlineTerminalContextLabel("debug session A")).toBe("@debug-session-a");
  });

  it("joins inline labels with a single space", () => {
    expect(
      buildInlineTerminalContextText([
        { header: "Dev Server lines 12-30" },
        { header: "My Shell line 7" },
      ]),
    ).toBe("@dev-server:12-30 @my-shell:7");
  });

  it("returns false when not every context's label is present", () => {
    expect(
      textContainsInlineTerminalContextLabels("look at @dev-server:12-30", [
        { header: "Dev Server lines 12-30" },
        { header: "My Shell line 7" },
      ]),
    ).toBe(false);
  });

  it("returns true when every label appears in order", () => {
    expect(
      textContainsInlineTerminalContextLabels("first @dev-server:12-30 then @my-shell:7 ok", [
        { header: "Dev Server lines 12-30" },
        { header: "My Shell line 7" },
      ]),
    ).toBe(true);
  });
});
