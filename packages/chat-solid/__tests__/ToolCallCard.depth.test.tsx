/**
 * Depth pass for `ToolCallCard`: status badge variants, long-output
 * truncation with "Show full output" expansion, and the
 * copy-output affordance that surfaces only when the body is open
 * and there's something to copy.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import {
  ToolCallCard,
  statusBadgeMeta,
  toolCallCopyText,
  truncateToolText,
} from "../src/components/ToolCallCard";
import type { ToolCallView } from "../src/types";

afterEach(() => {
  document.body.innerHTML = "";
});

function toolCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: "tc-1",
    title: "Run tests",
    kind: "bash",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "ok" } }],
    ...overrides,
  };
}

describe("statusBadgeMeta", () => {
  it("maps completed to done", () => {
    expect(statusBadgeMeta("completed").variant).toBe("done");
  });
  it("maps failed to error", () => {
    expect(statusBadgeMeta("failed").variant).toBe("error");
  });
  it("maps in_progress / pending to running", () => {
    expect(statusBadgeMeta("in_progress").variant).toBe("running");
    expect(statusBadgeMeta("pending").variant).toBe("running");
  });
  it("falls back to queued for missing status", () => {
    expect(statusBadgeMeta(null).variant).toBe("queued");
    expect(statusBadgeMeta(undefined).variant).toBe("queued");
  });
});

describe("toolCallCopyText", () => {
  it("concatenates text blocks and diff payloads", () => {
    const call = toolCall({
      content: [
        { type: "content", content: { type: "text", text: "first" } },
        { type: "diff", path: "src/foo.ts", newText: "next" },
        { type: "content", content: { type: "text", text: "tail" } },
      ],
    });
    expect(toolCallCopyText(call)).toBe("first\n# src/foo.ts\nnext\ntail");
  });
  it("returns empty for content-less calls", () => {
    expect(toolCallCopyText(toolCall({ content: [] }))).toBe("");
  });
});

describe("truncateToolText", () => {
  it("preserves short text", () => {
    expect(truncateToolText("a\nb")).toEqual({ visible: "a\nb", hiddenLines: 0, truncated: false });
  });
  it("clips past the line limit and reports hidden lines", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = truncateToolText(text, { maxLines: 5 });
    expect(result.truncated).toBe(true);
    expect(result.hiddenLines).toBe(15);
    expect(result.visible.split("\n")).toHaveLength(5);
  });
  it("clips past the char cap", () => {
    const result = truncateToolText("x".repeat(2_000), { maxChars: 100, maxLines: 50 });
    expect(result.truncated).toBe(true);
    expect(result.visible.endsWith("…")).toBe(true);
    expect(result.visible.length).toBe(101);
  });
});

describe("ToolCallCard rendering", () => {
  it("renders the status badge with the matching variant", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <ToolCallCard toolCall={toolCall({ status: "in_progress" })} />, container);
    const badge = container.querySelector("[data-testid='tool-call-card-status']");
    expect(badge?.getAttribute("data-status")).toBe("running");
    expect(badge?.textContent?.toLowerCase()).toContain("running");
  });

  it("flips the badge to error for failed calls", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <ToolCallCard toolCall={toolCall({ status: "failed" })} />, container);
    expect(
      container.querySelector("[data-testid='tool-call-card-status']")?.getAttribute("data-status"),
    ).toBe("error");
  });

  it("does not surface the copy chip while the body is collapsed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <ToolCallCard toolCall={toolCall()} />, container);
    expect(container.querySelector("[data-testid='tool-call-card-copy']")).toBeNull();
  });

  it("reveals the copy chip after the user opens the card", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <ToolCallCard toolCall={toolCall()} />, container);
    const details = container.querySelector<HTMLDetailsElement>(
      "[data-testid='tool-call-card']",
    );
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));
    expect(container.querySelector("[data-testid='tool-call-card-copy']")).toBeTruthy();
  });

  it("clips long tool output with a 'Show full output' affordance", () => {
    const longText = Array.from({ length: 30 }, (_, i) => `step ${i + 1}`).join("\n");
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      () => (
        <ToolCallCard
          toolCall={toolCall({
            content: [{ type: "content", content: { type: "text", text: longText } }],
          })}
        />
      ),
      container,
    );
    const details = container.querySelector<HTMLDetailsElement>(
      "[data-testid='tool-call-card']",
    );
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));

    const showMore = container.querySelector<HTMLButtonElement>(
      "[data-testid='tool-call-show-more']",
    );
    expect(showMore).toBeTruthy();
    expect(showMore!.getAttribute("data-hidden-lines")).toBe("18");
    expect(container.querySelector("[data-testid='tool-call-text']")?.textContent).not.toContain(
      "step 25",
    );

    showMore!.click();
    expect(container.querySelector("[data-testid='tool-call-show-more']")).toBeNull();
    expect(container.querySelector("[data-testid='tool-call-text']")?.textContent).toContain(
      "step 30",
    );
  });
});
