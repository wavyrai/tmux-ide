/**
 * Polish pass on the composer draft store (CHAT-8):
 *
 *   - Attachment round-trip: file + terminal kinds survive a reload;
 *     image attachments are intentionally dropped (data URLs would
 *     blow past the 5MB localStorage quota).
 *   - Stale-draft eviction: entries older than 30 days drop on read.
 *   - Cross-tab subscription: a `storage` event from a sibling tab
 *     fans out to subscribers watching the same thread, and only to
 *     subscribers whose draft actually moved.
 *   - clearDraft drops the entry across reloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __FLUSH_DEBOUNCE_MS_FOR_TESTS,
  __resetComposerDraftStoreForTests,
  __STALE_DRAFT_MS_FOR_TESTS,
  __STORAGE_KEY_FOR_TESTS,
  clearDraft,
  flushDrafts,
  loadDraft,
  loadDraftAttachments,
  saveDraft,
  subscribeDraft,
} from "../src/lib/composerDraftStore";
import type { ComposerAttachment } from "../src/types";

beforeEach(() => {
  __resetComposerDraftStoreForTests();
});

afterEach(() => {
  __resetComposerDraftStoreForTests();
});

describe("composerDraftStore — attachment round-trip", () => {
  it("persists file + terminal attachments and re-reads them on a fresh load", () => {
    const fileAttachment: ComposerAttachment = {
      kind: "file",
      path: "src/foo.ts",
      label: "foo.ts",
    };
    const terminalAttachment: ComposerAttachment = {
      kind: "terminal",
      paneId: "p-1",
      paneTitle: "Dev",
      sessionName: "alpha",
    };

    saveDraft("thread-A", "hello", [fileAttachment, terminalAttachment]);
    flushDrafts();
    __resetComposerDraftStoreForTests(); // simulate reload — drop in-memory cache
    // Restore from disk (the reset cleared localStorage too, so we
    // re-stash by hand to mimic a reload from a previously-saved tab).
    localStorage.setItem(
      __STORAGE_KEY_FOR_TESTS,
      JSON.stringify({
        "thread-A": {
          prompt: "hello",
          attachments: [
            { kind: "file", path: "src/foo.ts", label: "foo.ts" },
            { kind: "terminal", paneId: "p-1", paneTitle: "Dev", sessionName: "alpha" },
          ],
          updatedAt: Date.now(),
        },
      }),
    );

    expect(loadDraft("thread-A")).toBe("hello");
    const attachments = loadDraftAttachments("thread-A");
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toEqual(fileAttachment);
    expect(attachments[1]).toEqual(terminalAttachment);
  });

  it("drops image attachments — data URLs are too heavy for localStorage", () => {
    const image: ComposerAttachment = {
      kind: "image",
      dataUrl: "data:image/png;base64,xxx",
      label: "hero.png",
    };
    const file: ComposerAttachment = { kind: "file", path: "x.ts", label: "x.ts" };
    saveDraft("thread-A", "see image", [image, file]);
    flushDrafts();
    // Re-read in this tab — the image is gone, file survives.
    const restored = loadDraftAttachments("thread-A");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(file);
  });

  it("drops the whole entry when prompt + attachments are both empty", () => {
    saveDraft("thread-A", "hi", [{ kind: "file", path: "a", label: "a" }]);
    flushDrafts();
    saveDraft("thread-A", "", []);
    flushDrafts();
    expect(loadDraft("thread-A")).toBe("");
    expect(loadDraftAttachments("thread-A")).toEqual([]);
    const raw = localStorage.getItem(__STORAGE_KEY_FOR_TESTS);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    expect(map["thread-A"]).toBeUndefined();
  });
});

describe("composerDraftStore — stale-draft eviction", () => {
  it("drops entries older than the 30-day cutoff on read", () => {
    const stale = Date.now() - __STALE_DRAFT_MS_FOR_TESTS - 1_000;
    const fresh = Date.now() - 60_000;
    localStorage.setItem(
      __STORAGE_KEY_FOR_TESTS,
      JSON.stringify({
        "stale-thread": { prompt: "ancient", updatedAt: stale },
        "fresh-thread": { prompt: "recent", updatedAt: fresh },
      }),
    );
    expect(loadDraft("stale-thread")).toBe("");
    expect(loadDraft("fresh-thread")).toBe("recent");
  });

  it("drops malformed entries with no numeric updatedAt", () => {
    localStorage.setItem(
      __STORAGE_KEY_FOR_TESTS,
      JSON.stringify({
        garbage: { prompt: "what" },
      }),
    );
    expect(loadDraft("garbage")).toBe("");
  });
});

describe("composerDraftStore — cross-tab subscribe", () => {
  it("fires for the watched thread when storage events land", async () => {
    saveDraft("thread-A", "initial");
    flushDrafts();

    const events: Array<string | null> = [];
    const unsubscribe = subscribeDraft("thread-A", (entry) => {
      events.push(entry?.prompt ?? null);
    });

    // Simulate a sibling tab writing a new value. We update
    // localStorage directly, then synthesize a `storage` event so
    // the listener fires (jsdom / happy-dom doesn't dispatch
    // storage events for same-document setItem calls).
    const next = {
      "thread-A": { prompt: "updated from other tab", updatedAt: Date.now() },
    };
    localStorage.setItem(__STORAGE_KEY_FOR_TESTS, JSON.stringify(next));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: __STORAGE_KEY_FOR_TESTS,
        newValue: JSON.stringify(next),
      }),
    );

    expect(events).toEqual(["updated from other tab"]);
    unsubscribe();
  });

  it("does not fire when an unrelated thread mutates", () => {
    saveDraft("thread-A", "alpha");
    saveDraft("thread-B", "beta");
    flushDrafts();

    const events: Array<string | null> = [];
    const unsubscribe = subscribeDraft("thread-A", (entry) => events.push(entry?.prompt ?? null));

    const next = {
      "thread-A": { prompt: "alpha", updatedAt: Date.now() - 1_000 },
      "thread-B": { prompt: "beta UPDATED", updatedAt: Date.now() },
    };
    localStorage.setItem(__STORAGE_KEY_FOR_TESTS, JSON.stringify(next));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: __STORAGE_KEY_FOR_TESTS,
        newValue: JSON.stringify(next),
      }),
    );

    expect(events).toEqual([]);
    unsubscribe();
  });

  it("fires with null when another tab clears the draft", () => {
    saveDraft("thread-A", "alpha");
    flushDrafts();

    const events: Array<string | null> = [];
    const unsubscribe = subscribeDraft("thread-A", (entry) => events.push(entry?.prompt ?? null));

    localStorage.setItem(__STORAGE_KEY_FOR_TESTS, JSON.stringify({}));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: __STORAGE_KEY_FOR_TESTS,
        newValue: JSON.stringify({}),
      }),
    );

    expect(events).toEqual([null]);
    unsubscribe();
  });

  it("unsubscribe stops further callbacks", () => {
    saveDraft("thread-A", "alpha");
    flushDrafts();

    const events: string[] = [];
    const unsubscribe = subscribeDraft("thread-A", (entry) => {
      events.push(entry?.prompt ?? "<null>");
    });
    unsubscribe();

    const next = {
      "thread-A": { prompt: "shouldn't fire", updatedAt: Date.now() },
    };
    localStorage.setItem(__STORAGE_KEY_FOR_TESTS, JSON.stringify(next));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: __STORAGE_KEY_FOR_TESTS,
        newValue: JSON.stringify(next),
      }),
    );

    expect(events).toEqual([]);
  });
});

describe("composerDraftStore — debounce + flush behavior", () => {
  it("debounces multiple writes within the flush window", () => {
    vi.useFakeTimers();
    try {
      saveDraft("thread-A", "h");
      saveDraft("thread-A", "he");
      saveDraft("thread-A", "hel");
      expect(localStorage.getItem(__STORAGE_KEY_FOR_TESTS)).toBeNull();
      vi.advanceTimersByTime(__FLUSH_DEBOUNCE_MS_FOR_TESTS + 1);
      const raw = localStorage.getItem(__STORAGE_KEY_FOR_TESTS);
      expect(raw).toBeTruthy();
      const map = JSON.parse(raw!) as Record<string, { prompt: string }>;
      expect(map["thread-A"]?.prompt).toBe("hel");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearDraft removes the entry across a flush", () => {
    saveDraft("thread-A", "hi");
    flushDrafts();
    clearDraft("thread-A");
    flushDrafts();
    expect(loadDraft("thread-A")).toBe("");
  });
});
