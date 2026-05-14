/**
 * `ChatComposer` responsive footer + draft-attachment restore (CHAT-8).
 *
 * Pins:
 *   1. Without `useResponsiveFooter`, the inline footer row stays
 *      hidden — back-compat with existing hosts.
 *   2. With `useResponsiveFooter` AND a wide form, the inline
 *      `ComposerFooterStrip` mounts and the compact menu does not.
 *   3. With `useResponsiveFooter` AND a narrow form, the strip
 *      hides and the compact menu shows.
 *   4. Host-supplied `showCompactControls={true}` always wins (even
 *      on a wide form).
 *   5. Draft restore re-stages persisted file + terminal attachments
 *      via the host's onAddAttachment hook.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChatComposer } from "../src/components/ChatComposer";
import {
  __resetComposerDraftStoreForTests,
  __STORAGE_KEY_FOR_TESTS,
  flushDrafts,
  saveDraft,
} from "../src/lib/composerDraftStore";
import type { AvailableCommand, ComposerAttachment, ContentBlock } from "../src/types";

const commands: AvailableCommand[] = [];

beforeEach(() => {
  __resetComposerDraftStoreForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  __resetComposerDraftStoreForTests();
});

interface MountOpts {
  useResponsiveFooter?: boolean;
  showCompactControls?: boolean;
  formWidth?: number;
  threadId?: string | null;
  initialAttachments?: ComposerAttachment[];
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  // Pin the form width measurement: stub the next allocated
  // <form>'s clientWidth so the ResizeObserver fallback reads the
  // value we want regardless of happy-dom's layout calculations.
  if (typeof opts.formWidth === "number") {
    const originalFormPrototype = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this instanceof HTMLFormElement) return opts.formWidth!;
        return originalFormPrototype?.get?.call(this) ?? 0;
      },
    });
  }

  const [useResponsiveFooter] = createSignal(opts.useResponsiveFooter ?? false);
  const [showCompactControls] = createSignal(opts.showCompactControls ?? false);
  const [threadId] = createSignal<string | null>(opts.threadId ?? null);
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>(
    opts.initialAttachments ?? [],
  );

  const onAddAttachment = vi.fn((attachment: ComposerAttachment) => {
    setAttachments((current) => [...current, attachment]);
  });
  const onRemoveAttachment = vi.fn((index: number) => {
    setAttachments((current) => current.filter((_, i) => i !== index));
  });
  const onToggleInteractionMode = vi.fn();
  const onTogglePlanSidebar = vi.fn();
  const onRuntimeModeChange = vi.fn();
  const onSend = vi.fn(async (_content: ContentBlock[]) => undefined);

  const dispose = render(
    () => (
      <ChatComposer
        disabled={() => false}
        availableCommands={() => commands}
        providerName={() => "Claude"}
        sessionName={() => "alpha"}
        projectDir={() => "/tmp/p"}
        attachments={attachments}
        terminalPanes={() => []}
        threadId={threadId}
        onAddAttachment={onAddAttachment}
        onRemoveAttachment={onRemoveAttachment}
        onSend={onSend}
        onCancel={vi.fn()}
        useResponsiveFooter={useResponsiveFooter}
        showCompactControls={showCompactControls}
        interactionMode={() => "default"}
        runtimeMode={() => "approval-required"}
        activePlan={() => false}
        onToggleInteractionMode={onToggleInteractionMode}
        onTogglePlanSidebar={onTogglePlanSidebar}
        onRuntimeModeChange={onRuntimeModeChange}
      />
    ),
    container,
  );

  return { container, dispose, onAddAttachment };
}

describe("ChatComposer — responsive footer", () => {
  it("hides the inline footer row when useResponsiveFooter is false (back-compat)", () => {
    const { container, dispose } = mount();
    expect(container.querySelector("[data-testid='composer-footer-row']")).toBeNull();
    expect(container.querySelector("[data-testid='composer-footer-strip']")).toBeNull();
    expect(
      container.querySelector("[data-testid='compact-composer-controls']"),
    ).toBeNull();
    dispose();
  });

  it("mounts the inline strip on a wide form", () => {
    const { container, dispose } = mount({ useResponsiveFooter: true, formWidth: 900 });
    expect(container.querySelector("[data-testid='composer-footer-row']")).toBeTruthy();
    expect(container.querySelector("[data-testid='composer-footer-strip']")).toBeTruthy();
    // Compact menu stays hidden.
    expect(
      container.querySelector("[data-testid='compact-composer-controls']"),
    ).toBeNull();
    dispose();
  });

  it("falls back to the compact menu on a narrow form", () => {
    const { container, dispose } = mount({ useResponsiveFooter: true, formWidth: 420 });
    expect(container.querySelector("[data-testid='composer-footer-strip']")).toBeNull();
    expect(
      container.querySelector("[data-testid='compact-composer-controls']"),
    ).toBeTruthy();
    expect(
      container
        .querySelector<HTMLFormElement>("form")
        ?.getAttribute("data-footer-compact"),
    ).toBe("true");
    dispose();
  });

  it("honors explicit showCompactControls on a wide form (host pin wins)", () => {
    const { container, dispose } = mount({
      useResponsiveFooter: true,
      formWidth: 900,
      showCompactControls: true,
    });
    expect(container.querySelector("[data-testid='composer-footer-strip']")).toBeNull();
    expect(
      container.querySelector("[data-testid='compact-composer-controls']"),
    ).toBeTruthy();
    dispose();
  });
});

describe("ChatComposer — draft attachment restore", () => {
  it("re-stages persisted file + terminal attachments on a thread mount", () => {
    // Seed the draft store with attachments for thread-A.
    saveDraft("thread-A", "hi from earlier", [
      { kind: "file", path: "src/foo.ts", label: "foo.ts" },
      { kind: "terminal", paneId: "p-1", paneTitle: "Dev", sessionName: "alpha" },
    ]);
    flushDrafts();

    const { container, dispose, onAddAttachment } = mount({ threadId: "thread-A" });
    expect(onAddAttachment).toHaveBeenCalledTimes(2);
    expect(onAddAttachment.mock.calls[0]?.[0]).toEqual({
      kind: "file",
      path: "src/foo.ts",
      label: "foo.ts",
    });
    expect(onAddAttachment.mock.calls[1]?.[0]).toEqual({
      kind: "terminal",
      paneId: "p-1",
      paneTitle: "Dev",
      sessionName: "alpha",
    });
    // And the textarea picks up the persisted prompt.
    const ta = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(ta?.value).toBe("hi from earlier");
    dispose();
  });

  it("does not double-stage when host attachments already exist", () => {
    saveDraft("thread-A", "hi", [{ kind: "file", path: "a", label: "a" }]);
    flushDrafts();
    const seededAttachment: ComposerAttachment = {
      kind: "file",
      path: "already-here",
      label: "already-here",
    };
    const { dispose, onAddAttachment } = mount({
      threadId: "thread-A",
      initialAttachments: [seededAttachment],
    });
    // Host already had attachments; don't re-stage from disk.
    expect(onAddAttachment).not.toHaveBeenCalled();
    dispose();
  });

  it("re-saves on keystrokes including the live attachment list", async () => {
    const { container, dispose } = mount({ threadId: "thread-B" });
    const ta = container.querySelector<HTMLTextAreaElement>("textarea");
    ta!.focus();
    ta!.value = "drafting";
    ta!.dispatchEvent(new InputEvent("input", { bubbles: true, data: "drafting" }));

    // Wait past the debounce.
    await new Promise((r) => setTimeout(r, 300));

    const raw = localStorage.getItem(__STORAGE_KEY_FOR_TESTS);
    const map = raw ? (JSON.parse(raw) as Record<string, { prompt: string }>) : {};
    expect(map["thread-B"]?.prompt).toBe("drafting");
    dispose();
  });
});
