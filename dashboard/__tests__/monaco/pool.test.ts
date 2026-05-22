/**
 * MonacoPool — lease / release / replenish under happy-dom.
 *
 * `@monaco-editor/loader` is mocked: tests provide a stub Monaco
 * namespace + factory so the pool exercises its lifecycle without
 * pulling Monaco's 4 MB bundle into happy-dom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StubEditor {
  id: number;
  disposed: boolean;
  optionsResets: number;
}

let nextEditorId = 1;

vi.mock("@monaco-editor/loader", () => {
  const m = {
    editor: {
      create: (_container: HTMLElement) => {
        const next: StubEditor = {
          id: nextEditorId++,
          disposed: false,
          optionsResets: 0,
        };
        return next;
      },
      setTheme: () => {},
    },
  };
  return { default: { init: () => Promise.resolve(m) } };
});

import { MonacoPool } from "@/lib/monaco/pool";

beforeEach(() => {
  nextEditorId = 1;
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MonacoPool", () => {
  it("pre-creates `reserveTarget` idle entries on init", async () => {
    const pool = new MonacoPool<StubEditor>({
      poolId: "test-pool-pre",
      reserveTarget: 3,
      createEditor: (m, c) =>
        (m as unknown as { editor: { create: (el: HTMLElement) => StubEditor } }).editor.create(c),
      cleanupOnRelease: () => {},
    });
    await pool.init();
    expect(pool._entriesForTests()).toHaveLength(3);
    for (const entry of pool._entriesForTests()) {
      expect(entry.status).toBe("idle");
    }
    // Off-screen root is mounted to body.
    expect(document.getElementById("test-pool-pre")).not.toBeNull();
  });

  it("lease flips an entry to leased and replenishes idle slots", async () => {
    const pool = new MonacoPool<StubEditor>({
      poolId: "test-pool-lease",
      reserveTarget: 2,
      createEditor: (m, c) =>
        (m as unknown as { editor: { create: (el: HTMLElement) => StubEditor } }).editor.create(c),
      cleanupOnRelease: () => {},
    });
    const lease1 = await pool.lease();
    expect(lease1.status).toBe("leased");

    // Background replenishment runs on the next microtask.
    await new Promise((r) => setTimeout(r, 0));
    const idle = pool._entriesForTests().filter((e) => e.status === "idle");
    expect(idle.length).toBeGreaterThanOrEqual(2);
  });

  it("release fires cleanupOnRelease, disposes per-lease disposables, reparents container", async () => {
    let cleanupCalls = 0;
    const pool = new MonacoPool<StubEditor>({
      poolId: "test-pool-release",
      reserveTarget: 1,
      createEditor: (m, c) =>
        (m as unknown as { editor: { create: (el: HTMLElement) => StubEditor } }).editor.create(c),
      cleanupOnRelease: () => {
        cleanupCalls += 1;
      },
    });
    const entry = await pool.lease();
    // Simulate a consumer mounting the container into the live tree.
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(entry.container);
    expect(entry.container.parentElement).toBe(host);

    let disposed = false;
    entry.disposables.push({ dispose: () => (disposed = true) });

    pool.release(entry);

    expect(disposed).toBe(true);
    expect(cleanupCalls).toBe(1);
    expect(entry.status).toBe("idle");
    expect(entry.container.parentElement?.id).toBe("test-pool-release");
  });
});
