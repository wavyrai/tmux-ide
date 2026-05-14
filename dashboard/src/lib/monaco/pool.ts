/**
 * Generic Monaco editor pool — type-parameterised over the editor
 * flavour (single-file `IStandaloneCodeEditor` or
 * `IStandaloneDiffEditor`).
 *
 * Pre-warmed editors live in an off-screen DOM root so Monaco's
 * `ResizeObserver` keeps measuring correctly; on lease the entry's
 * container is reparented into the consumer's tree. Cold-creating a
 * Monaco editor is 200–400 ms even on a warm V8; a pool lease
 * collapses that to a single DOM move (~ms).
 *
 * Ported from `monaco-pool.ts` — same shape, swapped the renderer's
 * structured logger for plain `console.warn` (we don't have a
 * matching logger here yet). The pool itself stays imperative —
 * Solid signals attach in `use-lease.ts`, not here.
 */

import loader from "@monaco-editor/loader";
import type * as monaco from "monaco-editor";

export type PoolEntry<TEditor> = {
  editor: TEditor;
  container: HTMLDivElement;
  status: "idle" | "leased";
  /** Per-lease event disposables — cleared on release. */
  disposables: monaco.IDisposable[];
};

export type MonacoPoolOptions<TEditor> = {
  /** DOM element id for this pool's off-screen container. */
  poolId: string;
  /** Number of idle instances to keep pre-warmed. Default: 1. */
  reserveTarget?: number;
  /** Factory: create a new editor instance inside the given container. */
  createEditor: (m: typeof monaco, container: HTMLDivElement) => TEditor;
  /**
   * Called during release before the container is reparented. Use to
   * dispose models, reset options, etc.
   */
  cleanupOnRelease: (editor: TEditor) => void;
  /** Called once after Monaco loads, before pre-warming entries. */
  onInit?: (m: typeof monaco) => Promise<void>;
};

const DEFAULT_RESERVE = 2;

export class MonacoPool<TEditor> {
  private pool: PoolEntry<TEditor>[] = [];
  private monacoInstance: typeof monaco | null = null;
  private reserveTarget: number;
  private initPromise: Promise<void> | null = null;
  private readonly options: MonacoPoolOptions<TEditor>;

  constructor(options: MonacoPoolOptions<TEditor>) {
    this.options = options;
    this.reserveTarget = options.reserveTarget ?? DEFAULT_RESERVE;
  }

  /**
   * Load Monaco, run `onInit`, and pre-create idle entries.
   * Safe to call multiple times — subsequent calls share the same
   * promise.
   */
  init(reserveTarget?: number): Promise<void> {
    if (reserveTarget !== undefined) this.reserveTarget = reserveTarget;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const m = await loader.init();
      this.monacoInstance = m as unknown as typeof monaco;
      // Expose Monaco globally so module-level singletons (e.g. the
      // model registry) can reach it without a circular import on
      // the pool.
      (globalThis as unknown as { __monaco?: typeof monaco }).__monaco = this.monacoInstance;
      if (this.options.onInit) await this.options.onInit(this.monacoInstance);
      for (let i = 0; i < this.reserveTarget; i += 1) {
        this.createEntry(this.monacoInstance);
      }
    })();

    return this.initPromise;
  }

  /**
   * Lease an idle editor instance. Creates one on-demand if none are
   * available. Schedules background replenishment after returning.
   */
  async lease(): Promise<PoolEntry<TEditor>> {
    if (!this.monacoInstance) await this.init();
    const m = this.monacoInstance;
    if (!m) throw new Error("MonacoPool: init() did not resolve");

    const idle = this.pool.find((e) => e.status === "idle");
    if (idle) {
      idle.status = "leased";
      void this.replenish();
      return idle;
    }

    const entry = this.createEntry(m);
    entry.status = "leased";
    void this.replenish();
    return entry;
  }

  /**
   * Return a leased entry to the pool. Disposes per-lease disposables,
   * runs `cleanupOnRelease`, reparents the container back to the
   * off-screen root.
   */
  release(entry: PoolEntry<TEditor>): void {
    for (const d of entry.disposables) {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    }
    entry.disposables = [];

    try {
      this.options.cleanupOnRelease(entry.editor);
    } catch (err) {
      console.warn(`[${this.options.poolId}] cleanupOnRelease error (suppressed):`, err);
    }

    try {
      this.getPoolRoot().appendChild(entry.container);
    } catch (err) {
      console.warn(`[${this.options.poolId}] container reparent error (suppressed):`, err);
    }

    entry.status = "idle";
  }

  /**
   * Set the global Monaco theme — affects every instance. Pass a
   * resolved theme name (`custom-dark` / `custom-light`), not a
   * dashboard theme id.
   */
  setTheme(themeName: string): void {
    this.monacoInstance?.editor.setTheme(themeName);
  }

  /** Returns the loaded Monaco namespace, or null if `init()` hasn't resolved. */
  getMonaco(): typeof monaco | null {
    return this.monacoInstance;
  }

  /** Test-only: snapshot of current pool entries. */
  _entriesForTests(): ReadonlyArray<PoolEntry<TEditor>> {
    return this.pool;
  }

  private createEntry(m: typeof monaco): PoolEntry<TEditor> {
    const root = this.getPoolRoot();
    const container = document.createElement("div");
    container.style.cssText = "width:100%;height:100%;";
    root.appendChild(container);

    const editor = this.options.createEditor(m, container);
    const entry: PoolEntry<TEditor> = {
      editor,
      container,
      status: "idle",
      disposables: [],
    };
    this.pool.push(entry);
    return entry;
  }

  private async replenish(): Promise<void> {
    if (!this.monacoInstance) return;
    const idleCount = this.pool.filter((e) => e.status === "idle").length;
    const needed = this.reserveTarget - idleCount;
    for (let i = 0; i < needed; i += 1) {
      this.createEntry(this.monacoInstance);
    }
  }

  private getPoolRoot(): HTMLDivElement {
    const id = this.options.poolId;
    let root = document.getElementById(id) as HTMLDivElement | null;
    if (!root) {
      root = document.createElement("div");
      root.id = id;
      // Off-screen but still in the DOM so Monaco's ResizeObserver
      // keeps measuring. `visibility:hidden` with real dimensions
      // avoids `display:none` breaking layout measurement.
      root.style.cssText =
        "position:fixed;top:-10000px;left:-10000px;width:800px;height:600px;" +
        "pointer-events:none;overflow:hidden;visibility:hidden;";
      document.body.appendChild(root);
    }
    return root;
  }
}

/** Read Monaco from `globalThis.__monaco`, set by `MonacoPool.init`. */
export function getMonacoFromGlobal(): typeof monaco | null {
  return (globalThis as unknown as { __monaco?: typeof monaco }).__monaco ?? null;
}
