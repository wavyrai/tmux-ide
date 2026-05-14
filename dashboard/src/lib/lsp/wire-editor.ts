/**
 * Wire LSP go-to-definition + diagnostics onto a leased Monaco editor.
 *
 * Three side-effects are installed per active buffer:
 *   1. An F12 action + Cmd/Ctrl-click mouse handler that POSTs to
 *      `/lsp/definition` and routes the result through `openFileAt`.
 *   2. A poll of `/lsp/diagnostics` whose results are converted into
 *      Monaco markers (`setModelMarkers`) and pushed to the shared
 *      diagnostics store so the Problems tab can render them.
 *   3. Cleanup on dispose: stops the poll, removes markers, and
 *      releases the action / mouse listener.
 *
 * Hover is wired separately via the `<LspHoverTooltip>` Solid
 * overlay component — keeping the markdown render path purely
 * declarative.
 *
 * The wiring intentionally only knows about the buffer-store URI:
 *   - It resolves `session.dir` lazily through `getSessionDir` so
 *     LSP-returned `file:///abs/path` URIs can be relativized.
 *   - It calls `openFileAt` from the existing `editorOpen` broker —
 *     it never reaches into the buffer-store internals.
 */

import type * as monaco from "monaco-editor";
import { getMonacoFromGlobal } from "@/lib/monaco/pool";
import { openFileAt } from "@/lib/editorOpen";
import {
  lspDefinition,
  lspDiagnostics,
  type LspDiagnostic,
  type LspLocation,
  type LspLocationLink,
} from "./api";
import { getSessionDir } from "./session-dir";
import { clearDiagnosticsForBuffer, setDiagnosticsForBuffer } from "./diagnostics-store";
import { computePollBackoffDelay } from "./poll-backoff";

export interface WireLspInput {
  editor: monaco.editor.IStandaloneCodeEditor;
  bufferUri: string;
  sessionName: string;
  /** Buffer-store rootPath (Monaco URI namespace — typically "/"). */
  rootPath: string;
  /** Workspace-relative file path the daemon LSP knows about. */
  filePath: string;
  /** Monaco language id ("typescript", "javascript", ...). */
  language: string;
}

const MARKER_OWNER = "lsp-daemon";
const DIAGNOSTIC_POLL_INTERVAL_MS = 5_000;
const FIRST_DIAGNOSTIC_DELAY_MS = 300;
/** Worst-case backoff. After this many consecutive errors the poll
 *  caps at 60s so a stale-daemon dashboard doesn't generate runaway
 *  request volume. A successful response resets the backoff. */
const DIAGNOSTIC_BACKOFF_MAX_MS = 60_000;
const DIAGNOSTIC_BACKOFF_FACTOR = 2;

/** LSP severity → Monaco MarkerSeverity. Falls back to Error for unknown
 *  inputs since "no severity" almost always means "fatal". */
function lspSeverityToMonaco(
  m: typeof monaco,
  severity: LspDiagnostic["severity"],
): monaco.MarkerSeverity {
  switch (severity) {
    case 2:
      return m.MarkerSeverity.Warning;
    case 3:
      return m.MarkerSeverity.Info;
    case 4:
      return m.MarkerSeverity.Hint;
    case 1:
    default:
      return m.MarkerSeverity.Error;
  }
}

function lspDiagnosticToMonaco(m: typeof monaco, d: LspDiagnostic): monaco.editor.IMarkerData {
  return {
    severity: lspSeverityToMonaco(m, d.severity),
    message: d.message,
    source: d.source ?? "lsp",
    code: d.code === undefined ? undefined : String(d.code),
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  };
}

/** Strip the `file://` URI returned by the LSP and turn it into a
 *  workspace-relative path under the resolved session.dir. Returns
 *  `null` when the result lives outside the workspace (a node_modules
 *  jump, say) — those need a different open path. */
function relativizeLspUri(uri: string, sessionDir: string): string | null {
  let absolute: string;
  try {
    absolute = decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
  const normalizedRoot = sessionDir.replace(/\/$/, "");
  if (absolute === normalizedRoot) return "";
  if (!absolute.startsWith(normalizedRoot + "/")) return null;
  return absolute.slice(normalizedRoot.length + 1);
}

/** Best-effort first-result extraction from any of the three LSP
 *  result shapes the spec allows (Location | Location[] | LocationLink[]). */
function firstDefinitionTarget(
  result: LspLocation | LspLocation[] | LspLocationLink[] | null,
): { uri: string; line: number; column: number } | null {
  if (!result) return null;
  if (Array.isArray(result)) {
    const first = result[0];
    if (!first) return null;
    if ("targetUri" in first) {
      return {
        uri: first.targetUri,
        line: first.targetSelectionRange.start.line,
        column: first.targetSelectionRange.start.character,
      };
    }
    return {
      uri: first.uri,
      line: first.range.start.line,
      column: first.range.start.character,
    };
  }
  return {
    uri: result.uri,
    line: result.range.start.line,
    column: result.range.start.character,
  };
}

async function gotoDefinitionAt(input: WireLspInput, position: monaco.Position): Promise<void> {
  let result;
  try {
    result = await lspDefinition(input.sessionName, {
      file: input.filePath,
      line: position.lineNumber - 1,
      column: position.column - 1,
    });
  } catch {
    return;
  }
  const target = firstDefinitionTarget(result.definition);
  if (!target) return;
  const sessionDir = await getSessionDir(input.sessionName);
  if (!sessionDir) return;
  const relPath = relativizeLspUri(target.uri, sessionDir);
  if (relPath === null || !relPath) return;
  openFileAt({
    sessionName: input.sessionName,
    rootPath: input.rootPath,
    filePath: relPath,
    language: input.language,
    // openFileAt is 1-based on lines, 0-based on columns.
    line: target.line + 1,
    column: target.column,
  });
}

export function wireLspToEditor(input: WireLspInput): () => void {
  const monacoInstance = getMonacoFromGlobal();
  if (!monacoInstance) return () => undefined;
  const m: typeof monaco = monacoInstance;
  const disposables: monaco.IDisposable[] = [];
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollAborted = false;

  // (1) F12 — go-to-definition at the current cursor.
  const action = input.editor.addAction({
    id: `lsp.gotoDefinition.${input.bufferUri}`,
    label: "Go to Definition",
    keybindings: [m.KeyCode.F12],
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.5,
    run: async (ed) => {
      const pos = ed.getPosition();
      if (!pos) return;
      await gotoDefinitionAt(input, pos);
    },
  });
  disposables.push(action);

  // Cmd-click (or Ctrl-click on non-mac). Monaco's existing Ctrl-click
  // gesture only triggers when a built-in DefinitionProvider is
  // registered; we'd rather route through our daemon-backed path, so
  // we intercept the mouse-down event directly.
  disposables.push(
    input.editor.onMouseDown((e) => {
      const native = e.event;
      const modifier = navigator.platform.toLowerCase().includes("mac")
        ? native.metaKey
        : native.ctrlKey;
      if (!modifier) return;
      const position = e.target.position;
      if (!position) return;
      // Skip clicks that aren't in the editable text area (gutter,
      // overlay, etc.).
      if (e.target.type !== m.editor.MouseTargetType.CONTENT_TEXT) return;
      native.preventDefault();
      native.stopPropagation();
      void gotoDefinitionAt(input, position);
    }),
  );

  // (2) Diagnostics — initial fetch + periodic refresh. The first
  // fetch is delayed so the daemon's LSP has a chance to index the
  // file post-didOpen.
  //
  // Consecutive errors back the poll cadence off exponentially (5s →
  // 10s → 20s → 40s → 60s cap). A successful response resets it. The
  // common trigger is "daemon was started before the LSP routes
  // landed" — the dashboard otherwise spams the same 404 every 5s
  // until the daemon is restarted, generating useless request volume
  // visible in devtools.
  let consecutiveErrors = 0;
  async function pollDiagnosticsOnce(): Promise<boolean> {
    if (pollAborted) return false;
    let result: { diagnostics: LspDiagnostic[] };
    try {
      result = await lspDiagnostics(input.sessionName, input.filePath);
    } catch {
      return false;
    }
    if (pollAborted) return false;
    const model = input.editor.getModel();
    if (model) {
      const markers = result.diagnostics.map((d) => lspDiagnosticToMonaco(m, d));
      m.editor.setModelMarkers(model, MARKER_OWNER, markers);
    }
    setDiagnosticsForBuffer({
      bufferUri: input.bufferUri,
      sessionName: input.sessionName,
      rootPath: input.rootPath,
      filePath: input.filePath,
      language: input.language,
      diagnostics: result.diagnostics,
      fetchedAt: Date.now(),
    });
    return true;
  }

  function nextPollDelay(): number {
    return computePollBackoffDelay(consecutiveErrors, {
      intervalMs: DIAGNOSTIC_POLL_INTERVAL_MS,
      maxMs: DIAGNOSTIC_BACKOFF_MAX_MS,
      factor: DIAGNOSTIC_BACKOFF_FACTOR,
    });
  }

  function schedulePoll(delay: number): void {
    if (pollAborted) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      const ok = await pollDiagnosticsOnce();
      if (ok) {
        consecutiveErrors = 0;
      } else {
        consecutiveErrors += 1;
      }
      schedulePoll(nextPollDelay());
    }, delay);
  }

  schedulePoll(FIRST_DIAGNOSTIC_DELAY_MS);

  // Re-fetch right after the user saves so the markers don't lag the
  // file content on disk.
  disposables.push(
    input.editor.onDidChangeModelContent(() => {
      // Debounce-ish: cancel any pending poll and reschedule a quick
      // refresh. The 5s steady-state poll picks up otherwise.
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      schedulePoll(FIRST_DIAGNOSTIC_DELAY_MS);
    }),
  );

  return () => {
    pollAborted = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    disposables.length = 0;
    const model = input.editor.getModel();
    if (model) {
      try {
        m.editor.setModelMarkers(model, MARKER_OWNER, []);
      } catch {
        /* model already disposed */
      }
    }
    clearDiagnosticsForBuffer(input.bufferUri);
  };
}
