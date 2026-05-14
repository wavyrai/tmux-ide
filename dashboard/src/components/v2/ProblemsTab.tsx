/**
 * Problems tab body — lists every LSP diagnostic the editor wiring
 * has observed across all open buffers. Clicking a row jumps the
 * editor to the diagnostic's line/column via `openFileAt`.
 *
 * Pure consumer of `diagnosticsState`; the wiring (CodeEditor's LSP
 * integration) is the producer.
 */

import { For, Show, createMemo, type JSX } from "solid-js";
import { diagnosticsState } from "@/lib/lsp/diagnostics-store";
import { openFileAt } from "@/lib/editorOpen";
import type { LspDiagnostic } from "@/lib/lsp/api";

interface FlatDiagnostic {
  bufferUri: string;
  sessionName: string;
  rootPath: string;
  filePath: string;
  language: string;
  diagnostic: LspDiagnostic;
}

function severityLabel(s: LspDiagnostic["severity"]): string {
  switch (s) {
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    case 1:
    default:
      return "error";
  }
}

function severityGlyph(s: LspDiagnostic["severity"]): string {
  switch (s) {
    case 2:
      return "⚠";
    case 3:
      return "i";
    case 4:
      return "•";
    case 1:
    default:
      return "✕";
  }
}

function severityClass(s: LspDiagnostic["severity"]): string {
  switch (s) {
    case 2:
      return "text-[var(--yellow,#d6a44b)]";
    case 3:
      return "text-[var(--blue,#5b8ee0)]";
    case 4:
      return "text-[var(--dim)]";
    case 1:
    default:
      return "text-[var(--red,#cc6666)]";
  }
}

function severityRank(s: LspDiagnostic["severity"]): number {
  return s ?? 1;
}

export function ProblemsTab(): JSX.Element {
  const flat = createMemo<FlatDiagnostic[]>(() => {
    const entries = Object.values(diagnosticsState.byBuffer).filter(Boolean);
    const rows: FlatDiagnostic[] = [];
    for (const entry of entries) {
      for (const diagnostic of entry.diagnostics) {
        rows.push({
          bufferUri: entry.bufferUri,
          sessionName: entry.sessionName,
          rootPath: entry.rootPath,
          filePath: entry.filePath,
          language: entry.language,
          diagnostic,
        });
      }
    }
    rows.sort((a, b) => {
      const sev = severityRank(a.diagnostic.severity) - severityRank(b.diagnostic.severity);
      if (sev !== 0) return sev;
      if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
      return a.diagnostic.range.start.line - b.diagnostic.range.start.line;
    });
    return rows;
  });

  return (
    <div
      data-testid="v2-problems-tab"
      class="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg)] text-[12px]"
    >
      <Show
        when={flat().length > 0}
        fallback={
          <div
            data-testid="v2-problems-empty"
            class="flex flex-1 items-center justify-center text-[11px] text-[var(--dim)]"
          >
            No problems detected in open files.
          </div>
        }
      >
        <ul class="min-h-0 flex-1 overflow-y-auto">
          <For each={flat()}>
            {(row) => {
              const line = () => row.diagnostic.range.start.line + 1;
              const column = () => row.diagnostic.range.start.character;
              return (
                <li>
                  <button
                    type="button"
                    data-testid="v2-problem-row"
                    data-severity={severityLabel(row.diagnostic.severity)}
                    onClick={() =>
                      openFileAt({
                        sessionName: row.sessionName,
                        rootPath: row.rootPath,
                        filePath: row.filePath,
                        language: row.language,
                        line: line(),
                        column: column(),
                      })
                    }
                    class="flex w-full items-start gap-2 border-b border-[var(--border-weak)] px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                  >
                    <span
                      aria-hidden="true"
                      class={
                        "mt-0.5 w-3 shrink-0 text-center " + severityClass(row.diagnostic.severity)
                      }
                    >
                      {severityGlyph(row.diagnostic.severity)}
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-[var(--fg)]">{row.diagnostic.message}</div>
                      <div class="truncate text-[10px] text-[var(--dim)]">
                        <span class="font-mono">{row.filePath}</span>
                        <span>
                          {" "}
                          · {line()}:{column() + 1}
                        </span>
                        <Show when={row.diagnostic.source}>{(src) => <span> · {src()}</span>}</Show>
                      </div>
                    </div>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}
