/**
 * DirectoryPicker — modal directory browser for the onboarding wizard.
 *
 * Browser file APIs (`<input type="file" webkitdirectory>`,
 * `window.showDirectoryPicker()`) sandbox the result and don't expose
 * absolute filesystem paths. We need the absolute path to hand to the
 * daemon, so the picker talks to the daemon's existing `/api/filesystem/browse`
 * endpoint, which has full FS access and enforces its own sandbox
 * (home dir + /Users, /home, /Volumes).
 */
import { createEffect, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { API_BASE } from "@/lib/api";

interface FilesystemEntry {
  name: string;
  fullPath: string;
  isDir: boolean;
  isSymlink: boolean;
}

interface FilesystemBrowseResult {
  path: string;
  parentPath: string | null;
  entries: FilesystemEntry[];
}

export interface DirectoryPickerProps {
  open: boolean;
  /** Initial path to display. Pass the current input value; defaults to home. */
  initialPath?: string;
  onClose: () => void;
  onSelect: (absolutePath: string) => void;
}

export function DirectoryPicker(props: DirectoryPickerProps) {
  const [current, setCurrent] = createSignal<FilesystemBrowseResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showHidden, setShowHidden] = createSignal(false);

  async function browse(path: string | null): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (path) params.set("path", path);
      if (showHidden()) params.set("showHidden", "true");
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/api/filesystem/browse${qs ? `?${qs}` : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as FilesystemBrowseResult;
      setCurrent(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Initial load + refresh on open / showHidden toggle.
  createEffect(() => {
    if (!props.open) return;
    void browse(props.initialPath?.trim() || null);
  });

  // Esc closes.
  onMount(() => {
    function onKey(e: KeyboardEvent) {
      if (!props.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  function segments(): { label: string; path: string }[] {
    const path = current()?.path;
    if (!path) return [];
    const parts = path.split("/").filter(Boolean);
    const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += `/${p}`;
      out.push({ label: p, path: acc });
    }
    return out;
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div
          role="dialog"
          aria-label="Pick a project directory"
          aria-modal="true"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <div
            class="flex h-[60vh] max-h-[640px] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-elevated,var(--bg-strong))] shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Breadcrumb bar */}
            <header class="flex h-[var(--chrome-h)] shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 text-sm">
              <For each={segments()}>
                {(seg, idx) => (
                  <>
                    <Show when={idx() > 0}>
                      <span class="text-[var(--dim)]">/</span>
                    </Show>
                    <button
                      type="button"
                      class="rounded px-1 text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                      onClick={() => void browse(seg.path)}
                    >
                      {seg.label === "/" ? "root" : seg.label}
                    </button>
                  </>
                )}
              </For>
              <Show when={!current()}>
                <span class="text-[var(--dim)]">loading…</span>
              </Show>
            </header>

            {/* Entry list */}
            <div class="min-h-0 flex-1 overflow-auto">
              <Show when={error()}>
                <p class="px-3 py-2 text-xs text-[var(--red-foreground,var(--red))]">{error()}</p>
              </Show>
              <Show when={current()?.parentPath}>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)]"
                  onClick={() => void browse(current()!.parentPath)}
                  data-testid="dirpicker-up"
                >
                  <span aria-hidden="true">↑</span>
                  <span>..</span>
                </button>
              </Show>
              <For each={(current()?.entries ?? []).filter((e) => e.isDir)}>
                {(entry) => (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                    onDblClick={() => void browse(entry.fullPath)}
                    onClick={() => void browse(entry.fullPath)}
                    data-testid={`dirpicker-entry-${entry.name}`}
                  >
                    <span aria-hidden="true" class="text-[var(--dim)]">
                      📁
                    </span>
                    <span class="truncate">{entry.name}</span>
                    <Show when={entry.isSymlink}>
                      <span class="text-xs text-[var(--dim)]">→</span>
                    </Show>
                  </button>
                )}
              </For>
              <Show when={current() && current()!.entries.filter((e) => e.isDir).length === 0}>
                <p class="px-3 py-4 text-center text-xs text-[var(--dim)]">
                  No subdirectories here.
                </p>
              </Show>
            </div>

            {/* Footer */}
            <footer class="flex h-[var(--chrome-h)] shrink-0 items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--bg-strong)] px-3 text-sm">
              <label class="flex items-center gap-1.5 text-xs text-[var(--dim)]">
                <input
                  type="checkbox"
                  checked={showHidden()}
                  onChange={(e) => {
                    setShowHidden(e.currentTarget.checked);
                    void browse(current()?.path ?? null);
                  }}
                />
                show hidden
              </label>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded border border-[var(--border)] bg-transparent px-2.5 py-1 text-xs text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)]"
                  onClick={() => props.onClose()}
                  data-testid="dirpicker-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--bg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!current() || loading()}
                  onClick={() => {
                    const p = current()?.path;
                    if (p) {
                      props.onSelect(p);
                      props.onClose();
                    }
                  }}
                  data-testid="dirpicker-select"
                >
                  Select this folder
                </button>
              </div>
            </footer>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
