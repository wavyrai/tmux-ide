/**
 * Symbol picker — Cmd+T (Ctrl+T on non-mac) opens a centred palette
 * that queries `/lsp/symbols` as the user types. Each row maps to an
 * LSP `SymbolInformation` and clicking it (or Enter on the focused
 * row) drives `openFileAt` at the symbol's location.
 *
 * The component is intentionally self-contained — it owns its own
 * keyboard handler so the route only has to mount one element per
 * project. A `getSessionDir()` lookup converts each LSP `file://`
 * URI into the workspace-relative path `openFileAt` expects.
 */

import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { lspSymbols, type LspSymbolInformation } from "@/lib/lsp/api";
import { openFileAt } from "@/lib/editorOpen";
import { getSessionDir } from "@/lib/lsp/session-dir";
import { relativizeWorkspaceUri } from "@/lib/lsp/workspace-edit";

const SYMBOL_QUERY_DEBOUNCE_MS = 150;
const MAX_RESULT_ROWS = 60;

// LSP `SymbolKind` → display glyph. The full enum is 1..26; for the
// picker we only annotate the kinds most users care about — anything
// else falls through to a neutral bullet.
function symbolGlyph(kind: number): string {
  switch (kind) {
    case 5:
      return "C"; // Class
    case 6:
      return "M"; // Method
    case 7:
      return "·"; // Property
    case 9:
      return "ƒ"; // Constructor
    case 10:
      return "E"; // Enum
    case 11:
      return "I"; // Interface
    case 12:
      return "ƒ"; // Function
    case 13:
      return "v"; // Variable
    case 14:
      return "k"; // Constant
    case 23:
      return "S"; // Struct
    default:
      return "•";
  }
}

export interface SymbolPickerProps {
  sessionName: string;
  /** Buffer-store rootPath — the Monaco URI namespace (typically "/"). */
  rootPath: string;
}

export function SymbolPicker(props: SymbolPickerProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<LspSymbolInformation[]>([]);
  const [focusIndex, setFocusIndex] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let inputRef!: HTMLInputElement;
  let queryTimer: ReturnType<typeof setTimeout> | null = null;
  let requestSeq = 0;

  function onKey(event: KeyboardEvent): void {
    const mod = navigator.platform.toLowerCase().includes("mac") ? event.metaKey : event.ctrlKey;
    if (mod && !event.shiftKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      setOpen(true);
      setFocusIndex(0);
      // Defer focus so the input is mounted before we try to focus it.
      queueMicrotask(() => inputRef?.focus());
      return;
    }
    if (open() && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // Debounced symbol query.
  createEffect(() => {
    const q = query();
    if (!open()) return;
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(async () => {
      const seq = ++requestSeq;
      setLoading(true);
      setError(null);
      try {
        const { symbols } = await lspSymbols(props.sessionName, q);
        if (seq !== requestSeq) return;
        setResults(symbols.slice(0, MAX_RESULT_ROWS));
        setFocusIndex(0);
      } catch (err) {
        if (seq !== requestSeq) return;
        setError(err instanceof Error ? err.message : String(err));
        setResults([]);
      } finally {
        if (seq === requestSeq) setLoading(false);
      }
    }, SYMBOL_QUERY_DEBOUNCE_MS);
  });

  onCleanup(() => {
    if (queryTimer) clearTimeout(queryTimer);
  });

  async function activate(symbol: LspSymbolInformation): Promise<void> {
    setOpen(false);
    const sessionDir = await getSessionDir(props.sessionName);
    if (!sessionDir) return;
    const filePath = relativizeWorkspaceUri(symbol.location.uri, sessionDir);
    if (filePath === null || !filePath) return;
    openFileAt({
      sessionName: props.sessionName,
      rootPath: props.rootPath,
      filePath,
      // The picker doesn't know per-file language; "plaintext" lets the
      // buffer-store register a fallback model + Monaco's language
      // detection fills it in once the buffer is hydrated.
      language: "plaintext",
      line: symbol.location.range.start.line + 1,
      column: symbol.location.range.start.character,
    });
  }

  function onInputKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      const list = results();
      const idx = focusIndex();
      if (list[idx]) void activate(list[idx]);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusIndex((i) => Math.min(results().length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
    }
  }

  return (
    <Show when={open()}>
      <Portal>
        <div
          data-testid="v2-symbol-picker-backdrop"
          class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            data-testid="v2-symbol-picker"
            class="flex w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-strong)] shadow-2xl"
          >
            <input
              ref={inputRef}
              data-testid="v2-symbol-picker-input"
              type="text"
              placeholder="Go to symbol in workspace…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onInputKey}
              class="border-b border-[var(--border)] bg-transparent px-3 py-2 text-md text-[var(--fg)] outline-none"
            />
            <Show when={error()}>
              <div class="px-3 py-1 text-sm text-[var(--red,#cc6666)]">{error()}</div>
            </Show>
            <ul class="max-h-[50vh] min-h-[40px] overflow-y-auto">
              <Show
                when={results().length > 0}
                fallback={
                  <li class="px-3 py-2 text-sm text-[var(--dim)]">
                    {loading() ? "Searching…" : "No symbols match."}
                  </li>
                }
              >
                <For each={results()}>
                  {(symbol, index) => {
                    const focused = () => index() === focusIndex();
                    return (
                      <li>
                        <button
                          type="button"
                          data-testid="v2-symbol-picker-row"
                          data-focused={focused() ? "true" : undefined}
                          onClick={() => void activate(symbol)}
                          class={
                            "flex w-full items-center gap-2 px-3 py-1 text-left text-base " +
                            (focused()
                              ? "bg-[var(--surface-hover)] text-[var(--accent)]"
                              : "text-[var(--fg)] hover:bg-[var(--surface-hover)]")
                          }
                        >
                          <span
                            aria-hidden="true"
                            class="w-4 shrink-0 text-center font-mono text-xs text-[var(--dim)]"
                          >
                            {symbolGlyph(symbol.kind)}
                          </span>
                          <span class="truncate font-mono">{symbol.name}</span>
                          <Show when={symbol.containerName}>
                            <span class="truncate text-xs text-[var(--dim)]">
                              {symbol.containerName}
                            </span>
                          </Show>
                          <span class="ml-auto truncate text-xs text-[var(--dim)]">
                            {symbol.location.uri.split("/").pop() ?? ""}
                          </span>
                        </button>
                      </li>
                    );
                  }}
                </For>
              </Show>
            </ul>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
