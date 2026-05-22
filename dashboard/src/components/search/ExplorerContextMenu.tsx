/**
 * Right-click context menu for the file explorer.
 *
 * Mounted once at the project route level; survives view switches.
 * Listens for `contextmenu` events at the document level and matches
 * both file rows (`[data-testid="v2-files-row"]` + `[data-file-path]`)
 * and directory rows (`[data-testid="v2-files-row-dir"]` +
 * `[data-dir-path]`) the FilesSurface tree emits.
 *
 * Document-level delegation (instead of patching FilesSurface) is
 * deliberate: the Files surface is actively maintained in another
 * silo; touching it risks the shared-index collisions we keep
 * running into. The DOM attributes are stable + already part of
 * the surface's testid contract, so this bridge stays a non-
 * invasive observer.
 *
 * Actions:
 *   - Reveal in Search (file → exact path; dir → folder include glob)
 *   - Copy path (relative workspace path)
 *   - Open in editor (files only) — broadcast via `filesBroker`
 *   - Open in terminal — copy `cd <relpath>` to clipboard
 *
 * Menu lifetime:
 *   - Opens at the pointer position; clamps to viewport so it
 *     doesn't clip off-screen on right-edge clicks.
 *   - Closes on outside pointerdown, Escape, scroll, or after any
 *     action fires.
 */

import { createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { Portal } from "solid-js/web";
import { Copy, FileText, Search, Terminal } from "lucide-solid";
import { folderIncludeGlob, requestSearch } from "@/lib/searchBroker";
import { requestOpenFile } from "@/lib/filesBroker";

interface ExplorerContextMenuProps {
  /** Called after the user picks an action that routes through the
   *  search panel ("Reveal in Search"). The host route uses this to
   *  switch the active view to `'search'`. */
  onRequestSearchView: () => void;
}

interface MenuState {
  /** Workspace-relative path the menu targets. */
  path: string;
  /** Whether the target row is a directory. */
  isDirectory: boolean;
  /** Pointer x in viewport pixels. */
  x: number;
  /** Pointer y in viewport pixels. */
  y: number;
}

const MENU_WIDTH = 220;
const ROW_HEIGHT = 28;
const MENU_PADDING = 8;

interface ActionItem {
  id: string;
  label: string;
  shortcut?: string;
  icon: typeof Search;
}

export function ExplorerContextMenu(props: ExplorerContextMenuProps) {
  const [state, setState] = createSignal<MenuState | null>(null);

  function close(): void {
    setState(null);
  }

  function onContextMenu(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const dirRow = target.closest<HTMLElement>('[data-testid="v2-files-row-dir"]');
    const fileRow = target.closest<HTMLElement>('[data-testid="v2-files-row"]');
    let path: string | null = null;
    let isDirectory = false;
    if (dirRow) {
      path = dirRow.getAttribute("data-dir-path");
      isDirectory = true;
    } else if (fileRow) {
      path = fileRow.getAttribute("data-file-path");
      isDirectory = false;
    }
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const itemCount = isDirectory ? 3 : 4;
    const menuHeightEstimate = ROW_HEIGHT * itemCount + 32;
    const x = Math.min(event.clientX, vw - MENU_WIDTH - MENU_PADDING);
    const y = Math.min(event.clientY, vh - menuHeightEstimate - MENU_PADDING);
    setState({ path, isDirectory, x, y });
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

  async function copyToClipboard(text: string): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* permission denied — best effort */
      }
    }
  }

  function revealInSearch(): void {
    const current = state();
    if (!current) return;
    requestSearch({
      include: current.isDirectory ? folderIncludeGlob(current.path) : current.path,
      focusInput: true,
      source: "explorer-context-menu",
    });
    close();
    props.onRequestSearchView();
  }

  function copyPath(): void {
    const current = state();
    if (!current) return;
    void copyToClipboard(current.path);
    close();
  }

  function openInEditor(): void {
    const current = state();
    if (!current || current.isDirectory) return;
    requestOpenFile({ filePath: current.path, source: "explorer-context-menu" });
    close();
  }

  function openInTerminal(): void {
    const current = state();
    if (!current) return;
    // Best-effort: copy a `cd <path>` command to the clipboard so the
    // user can paste it into an attached tmux pane. A native pane-
    // dispatch wire-up would be cleaner; this matches what we can
    // do without a new daemon API.
    const target = current.isDirectory ? current.path : current.path.replace(/\/[^/]*$/, "") || ".";
    void copyToClipboard(`cd ${target}`);
    close();
  }

  return (
    <Show when={state()}>
      {(s) => {
        const items: Array<ActionItem & { onPick: () => void }> = [
          {
            id: "reveal-in-search",
            label: s().isDirectory ? "Find in folder…" : "Reveal in Search",
            shortcut: "⇧⌘F",
            icon: Search,
            onPick: revealInSearch,
          },
          {
            id: "copy-path",
            label: "Copy path",
            icon: Copy,
            onPick: copyPath,
          },
          ...(s().isDirectory
            ? []
            : [
                {
                  id: "open-in-editor",
                  label: "Open in editor",
                  icon: FileText,
                  onPick: openInEditor,
                } as ActionItem & { onPick: () => void },
              ]),
          {
            id: "open-in-terminal",
            label: "Open in terminal",
            icon: Terminal,
            onPick: openInTerminal,
          },
        ];
        return (
          <Portal>
            <div
              data-testid="explorer-context-menu"
              data-target-kind={s().isDirectory ? "dir" : "file"}
              role="menu"
              aria-label={`Actions for ${s().path}`}
              style={{
                position: "fixed",
                left: `${s().x}px`,
                top: `${s().y}px`,
                "min-width": `${MENU_WIDTH}px`,
              }}
              class="z-50 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
            >
              <div class="px-3 py-1 text-xs uppercase tracking-wider text-[var(--dim)]">
                {s().path}
              </div>
              <For each={items}>
                {(item) => (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`explorer-context-${item.id}`}
                    onClick={item.onPick}
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-base text-[var(--fg)] hover:bg-[var(--surface-hover,var(--bg-strong))]"
                  >
                    <item.icon size={14} />
                    <span>{item.label}</span>
                    <Show when={item.shortcut}>
                      <span class="ml-auto text-xs text-[var(--dim)]">{item.shortcut}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}
