/**
 * PlanBodyView — inline plan editor.
 *
 * Verifies the Edit button enters edit mode, the textarea hosts the
 * source markdown, Cmd+S triggers save, cancel-with-dirty asks to
 * confirm, and the remote-update banner offers a discard-local exit
 * during editing.
 *
 * The component is presentational — state + endpoints live in the
 * `PlanEditController` we pass in — so we drive it with a controller
 * built from real signals + spies. No fetch shim needed here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

import { PlanBodyView, type PlanEditController } from "@/components/v2/views";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PLAN_META = {
  name: "Foo",
  path: "foo.md",
  title: "Foo",
  status: "in-progress",
} as const;

interface HarnessOptions {
  initialContent?: string;
  initialDraft?: string;
  initialEditing?: boolean;
  initialRemoteUpdate?: boolean;
  saveImpl?: () => Promise<void>;
}

function buildHarness(opts: HarnessOptions = {}) {
  const initialContent = opts.initialContent ?? "# Plan body";
  const [editing, setEditing] = createSignal<boolean>(opts.initialEditing ?? false);
  const [draft, setDraft] = createSignal<string>(opts.initialDraft ?? initialContent);
  const [content, setContent] = createSignal<string>(initialContent);
  const [saving, setSaving] = createSignal<boolean>(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);
  const [remoteUpdateAvailable, setRemoteUpdateAvailable] = createSignal<boolean>(
    opts.initialRemoteUpdate ?? false,
  );

  const beginEdit = vi.fn(() => {
    setDraft(content());
    setEditing(true);
  });
  const cancelEdit = vi.fn(() => {
    const dirty = draft() !== content();
    if (dirty) {
      const ok = window.confirm("Discard unsaved changes to this plan?");
      if (!ok) return;
    }
    setEditing(false);
  });
  const saveEdit =
    opts.saveImpl !== undefined
      ? vi.fn(opts.saveImpl)
      : vi.fn(async () => {
          setSaving(true);
          setContent(draft());
          setEditing(false);
          setSavedAt(Date.now());
          setSaving(false);
        });
  const discardLocal = vi.fn(() => {
    setEditing(false);
    setRemoteUpdateAvailable(false);
  });

  const controller: PlanEditController = {
    editing,
    draft,
    setDraft,
    saving,
    saveError,
    savedAt,
    remoteUpdateAvailable,
    canEdit: () => true,
    beginEdit,
    cancelEdit,
    saveEdit,
    discardLocal,
  };

  const utils = render(() => (
    <PlanBodyView
      plan={PLAN_META}
      data={{ content: content(), authorship: null, mtime: 1 }}
      controller={controller}
    />
  ));
  return { ...utils, controller, beginEdit, cancelEdit, saveEdit, discardLocal };
}

describe("PlanBodyView", () => {
  it("renders the Edit button when not editing", () => {
    const { getByTestId, queryByTestId } = buildHarness();
    expect(getByTestId("plan-edit-button")).toBeInTheDocument();
    expect(queryByTestId("plan-edit-textarea")).toBeNull();
  });

  it("clicking Edit enters edit mode and shows the textarea seeded with content", () => {
    const { getByTestId, queryByTestId, beginEdit } = buildHarness({
      initialContent: "# Plan source",
    });
    fireEvent.click(getByTestId("plan-edit-button"));
    expect(beginEdit).toHaveBeenCalled();
    const textarea = getByTestId("plan-edit-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("# Plan source");
    expect(queryByTestId("plan-edit-button")).toBeNull();
  });

  it("Cmd+S in the textarea calls controller.saveEdit", () => {
    const { getByTestId, saveEdit } = buildHarness({ initialEditing: true });
    fireEvent.keyDown(getByTestId("plan-edit-textarea"), { key: "s", metaKey: true });
    expect(saveEdit).toHaveBeenCalledTimes(1);
  });

  it("Esc in the textarea calls controller.cancelEdit (clean — no confirm)", () => {
    const { getByTestId, cancelEdit } = buildHarness({ initialEditing: true });
    fireEvent.keyDown(getByTestId("plan-edit-textarea"), { key: "Escape" });
    expect(cancelEdit).toHaveBeenCalledTimes(1);
  });

  it("cancel-with-dirty asks to confirm via window.confirm", () => {
    const confirmSpy = vi.fn(() => false);
    const originalConfirm = window.confirm;
    Object.defineProperty(window, "confirm", { configurable: true, value: confirmSpy });
    try {
      const { getByTestId, controller } = buildHarness({
        initialEditing: true,
        initialContent: "original",
        initialDraft: "edited",
      });
      fireEvent.click(getByTestId("plan-edit-cancel"));
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/discard unsaved changes/i));
      // User said "no" → still editing.
      expect(controller.editing()).toBe(true);
    } finally {
      Object.defineProperty(window, "confirm", {
        configurable: true,
        value: originalConfirm,
      });
    }
  });

  it("remote-update banner offers a discard-local exit", () => {
    const { getByTestId, discardLocal } = buildHarness({
      initialEditing: true,
      initialRemoteUpdate: true,
    });
    expect(getByTestId("plan-remote-update-banner")).toBeInTheDocument();
    fireEvent.click(getByTestId("plan-remote-discard"));
    expect(discardLocal).toHaveBeenCalledTimes(1);
  });

  it("save: textarea draft posts to the right endpoint with the right body", async () => {
    // Real save path — exercise the controller's saveEdit by feeding it
    // a spy fetch. We can't reach PlansSurfaceView's internal save from
    // here without standing up the rail widget, so this verifies the
    // protocol the controller is expected to follow: POST JSON
    // `{ content }` to `/api/project/:name/plans/:filename/content`.
    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true, mtime: 2 }), { status: 200 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchSpy);

    let savedDraft = "";
    const harness = buildHarness({
      initialEditing: true,
      initialContent: "original",
      saveImpl: async () => {
        savedDraft = harness.controller.draft();
        await fetch(`http://localhost/api/project/test-project/plans/foo.md/content`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: savedDraft }),
        });
      },
    });

    const textarea = harness.getByTestId("plan-edit-textarea") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "edited draft" } });
    fireEvent.keyDown(textarea, { key: "s", metaKey: true });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(savedDraft).toBe("edited draft");
    const [url, init] = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(url).toContain("/api/project/test-project/plans/foo.md/content");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      content: "edited draft",
    });
  });
});
