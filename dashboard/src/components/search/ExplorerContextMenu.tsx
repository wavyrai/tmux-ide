/**
 * Right-click context menu for the file explorer (G19-P4).
 *
 * Mounted once at the project route level; survives view switches.
 * Listens for `contextmenu` events at the document level, filters
 * for directory rows in the Files surface (matched via the
 * `[data-testid="v2-files-row-dir"]` + `[data-dir-path]` attributes
 * the existing tree already emits), and renders a small floating
 * menu via Solid Portal with "Find in folder".
 *
 * Document-level delegation (instead of patching FilesSurface) is
 * deliberate: the Files surface is actively maintained in another
 * silo; touching it risks the shared-index collisions we keep
 * running into. The DOM attributes are stable + already part of
 * the surface's testid contract, so this bridge stays a non-
 * invasive observer.
 *
 * Menu lifetime:
 *   - Opens at the pointer position; clamps to viewport so it
 *     doesn't clip off-screen on right-edge clicks.
 *   - Closes on outside pointerdown, Escape, scroll, or after the
 *     "Find in folder" action fires.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Search } from "lucide-solid";
import { folderIncludeGlob, requestSearch } from "@/lib/searchBroker";

interface ExplorerContextMenuProps {
  /** Called after the user clicks "Find in folder". The host route
   *  uses this to switch the active view to `'search'`. */
  onRequestSearchView: () => void;
}

interface MenuState {
  /** Workspace-relative directory path the menu targets. */
  dirPath: string;
  /** Pointer x in viewport pixels. */
  x: number;
  /** Pointer y in viewport pixels. */
  y: number;
}

const MENU_WIDTH = 192;
const MENU_HEIGHT_ESTIMATE = 56; // 1 row × 28 plus padding

export function ExplorerContextMenu(props: ExplorerContextMenuProps) {
  const [state, setState] = createSignal<MenuState | null>(null);

  function close(): void {
    setState(null);
  }

  function onContextMenu(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLElement>('[data-testid="v2-files-row-dir"]');
    if (!row) return;
    const dirPath = row.getAttribute("data-dir-path");
    if (!dirPath) return;
    event.preventDefault();
    event.stopPropagation();

    // Clamp to viewport — the menu shouldn't clip off-screen when the
    // user right-clicks near the right edge of the file tree.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.min(event.clientX, vw - MENU_WIDTH - 8);
    const y = Math.min(event.clientY, vh - MENU_HEIGHT_ESTIMATE - 8);
    setState({ dirPath, x, y });
  }

  function onPointerDown(event: PointerEvent): void {
    const current = state();
    if (!current) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      close();
      return;
    }
    if (target.closest('[data-testid="explorer-context-menu"]')) return;
    close();
  }

  function onKey(event: KeyboardEvent): void {
    if (!state()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  function onScroll(): void {
    close();
  }

  onMount(() => {
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    });
  });

  function findInFolder(): void {
    const current = state();
    if (!current) return;
    requestSearch({
      include: folderIncludeGlob(current.dirPath),
      focusInput: true,
      source: "explorer-context-menu",
    });
    close();
    props.onRequestSearchView();
  }

  return (
    <Show when={state()}>
      {(s) => (
        <Portal>
          <div
            data-testid="explorer-context-menu"
            role="menu"
            aria-label={`Actions for ${s().dirPath}`}
            style={{
              position: "fixed",
              left: `${s().x}px`,
              top: `${s().y}px`,
              "min-width": `${MENU_WIDTH}px`,
            }}
            class="z-50 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
          >
            <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--dim)]">
              {s().dirPath}
            </div>
            <button
              type="button"
              data-testid="explorer-context-find-in-folder"
              onClick={findInFolder}
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--fg)] hover:bg-[var(--surface-hover,var(--bg-strong))]"
            >
              <Search size={14} />
              <span>Find in folder…</span>
              <span class="ml-auto text-[10px] text-[var(--dim)]">⇧⌘F</span>
            </button>
          </div>
        </Portal>
      )}
    </Show>
  );
}
