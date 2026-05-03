import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlansView } from "./PlansView";

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor({
    value,
    onChange,
  }: {
    value: string;
    onChange(value: string): void;
    onSave(value: string): void;
  }) {
    return (
      <textarea
        data-testid="markdown-editor"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  },
}));

const PLAN = `---
title: Test Plan
status: pending
---
# Test Plan

Initial body
`;

class MockIntersectionObserver {
  observe(): void {}
  disconnect(): void {}
}

describe("PlansView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/project/alpha/plans/foo.md/content")) {
          return Promise.resolve(Response.json({ ok: true, mtime: 2 }));
        }
        if (url.endsWith("/api/project/alpha/plans/foo.md")) {
          return Promise.resolve(
            Response.json({ name: "foo", content: PLAN, marks: null, stats: null, mtime: 1 }),
          );
        }
        if (url.endsWith("/api/project/alpha/plans")) {
          return Promise.resolve(
            Response.json({
              plans: [
                {
                  name: "foo",
                  path: "foo.md",
                  title: "Test Plan",
                  status: "pending",
                  effort: null,
                  owner: null,
                  updated: "2026-05-03T00:00:00Z",
                  completed: null,
                },
              ],
            }),
          );
        }
        if (url.endsWith("/api/project/alpha")) {
          return Promise.resolve(
            Response.json({
              session: "alpha",
              dir: "/tmp/alpha",
              tasks: [],
              goals: [],
              agents: [],
            }),
          );
        }
        return Promise.resolve(Response.json({}));
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists edit mode and saves content after a debounce", async () => {
    render(<PlansView sessionName="alpha" />);

    await screen.findByRole("heading", { name: "Test Plan" });
    fireEvent.click(screen.getByTestId("plan-edit-toggle"));

    expect(screen.getByTestId("markdown-editor")).toBeTruthy();
    expect(window.localStorage.getItem("tmux-ide.plans.editing.v1")).toContain("alpha:foo.md");

    vi.useFakeTimers();
    fireEvent.change(screen.getByTestId("markdown-editor"), {
      target: { value: `${PLAN}\nSaved from test` },
    });
    await act(async () => {
      vi.advanceTimersByTime(850);
      await Promise.resolve();
      await Promise.resolve();
    });

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const saveCall = calls.find(([url]) => String(url).endsWith("/plans/foo.md/content"));
    expect(saveCall?.[1]?.body).toContain("Saved from test");
  });
});
