import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Persist } from "./persist";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class ThrowOnceStorage extends MemoryStorage {
  throwsRemaining = 1;

  override setItem(key: string, value: string): void {
    if (this.throwsRemaining > 0) {
      this.throwsRemaining -= 1;
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }
    super.setItem(key, value);
  }
}

function installStorage(storage: Storage): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  installStorage(new MemoryStorage());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Persist.global", () => {
  it("reads defaults, writes data, and clears all versioned keys", () => {
    const store = Persist.global("tmux-ide.test", ["v1"], { count: 0 });

    expect(store.read()).toEqual({ count: 0 });

    store.write({ count: 2 });
    expect(window.localStorage.getItem("tmux-ide.test.v1")).toBe(JSON.stringify({ count: 2 }));
    expect(store.read()).toEqual({ count: 2 });

    store.clear();
    expect(window.localStorage.getItem("tmux-ide.test.v1")).toBeNull();
    expect(store.read()).toEqual({ count: 0 });
  });

  it("falls through legacy versions and applies migrations", () => {
    window.localStorage.setItem("tmux-ide.test.v1", JSON.stringify({ count: 3 }));
    const store = Persist.global(
      "tmux-ide.test",
      ["v1", "v2"],
      { total: 0 },
      {
        v2: (prev) => ({ total: (prev as { count: number }).count + 1 }),
      },
    );

    expect(store.read()).toEqual({ total: 4 });
  });

  it("logs, evicts the oldest versioned key, and retries once on quota errors", () => {
    const storage = new ThrowOnceStorage();
    storage.throwsRemaining = 0;
    storage.setItem("tmux-ide.test.v1", JSON.stringify({ count: 1 }));
    storage.throwsRemaining = 1;
    installStorage(storage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = Persist.global("tmux-ide.test", ["v1", "v2"], { count: 0 });

    store.write({ count: 2 });

    expect(warn).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem("tmux-ide.test.v1")).toBeNull();
    expect(window.localStorage.getItem("tmux-ide.test.v2")).toBe(JSON.stringify({ count: 2 }));
  });

  it("no-ops writes when quota retry also fails", () => {
    const storage = new ThrowOnceStorage();
    storage.throwsRemaining = 2;
    installStorage(storage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = Persist.global("tmux-ide.test", ["v1"], { count: 0 });

    store.write({ count: 2 });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem("tmux-ide.test.v1")).toBeNull();
  });
});
