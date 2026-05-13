/**
 * CodeEditor — Solid wrapper around a leased Monaco code editor.
 *
 * Mounts on the `codeEditorPool` lease (G17-P1): one DOM reparent
 * gives us a pre-warmed editor (~ms instead of 200-400 ms cold).
 * Reattaches when `props.uri` changes; releases the lease on
 * unmount.
 *
 * Read-only for G17-P4. Buffer-side write-through + dirty tracking
 * + Cmd+S save lands in G17-P5 alongside the buffer registration
 * flow.
 *
 * The host is responsible for:
 *   - Calling `modelRegistry.registerDisk({...})` before passing the
 *     resulting URI to this component (the editor renders empty
 *     until `modelStatus(uri) === 'ready'`).
 *   - Calling `modelRegistry.unregisterModel(uri)` once nothing else
 *     needs the model — the registry handles the 60s eviction TTL.
 */

import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type * as monaco from "monaco-editor";
import { codeEditorPool, type CodePoolEntry } from "@/lib/monaco/code-pool";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { bufferState } from "@/lib/editor/buffer-store";
import { wireLspToEditor } from "@/lib/lsp/wire-editor";
import { LspHoverTooltip } from "@/components/editor/LspHoverTooltip";

export interface CodeEditorProps {
  /**
   * URI of the model to attach. Typically a `disk://` URI returned
   * by `modelRegistry.registerDisk({...})` (the buffer URI's body
   * with a `disk://` scheme).
   */
  uri: string;
  /** Force read-only on the underlying editor. Defaults to true (P4). */
  readOnly?: boolean;
  /** Notify when the leased editor is mounted (or unmounted = null). */
  onEditorChange?: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
  /**
   * Fired when the attached Monaco model's text changes. The
   * buffer-store wires this into `markContent(uri, value)` so the
   * tab-strip's dirty indicator + Cmd+S flow stay in sync. Omit
   * for read-only mounts.
   */
  onContentChange?: (value: string) => void;
}

export function CodeEditor(props: CodeEditorProps) {
  let host!: HTMLDivElement;
  let entry: CodePoolEntry | null = null;
  let cancelled = false;
  let lastAttachedUri: string | undefined;
  let contentDisposable: monaco.IDisposable | null = null;
  // LSP wiring lifecycle — one wiring per (editor, bufferUri) tuple.
  // Re-applied whenever the URI changes (buffer swap) so the daemon
  // talks to the right `filePath`.
  let lspDispose: (() => void) | null = null;
  let lspWiredFor: string | undefined;
  const [editorSignal, setEditorSignal] = createSignal<
    monaco.editor.IStandaloneCodeEditor | null
  >(null);
  const [activeBufferMeta, setActiveBufferMeta] = createSignal<{
    sessionName: string;
    filePath: string;
  } | null>(null);

  onMount(() => {
    void codeEditorPool.lease().then((leased) => {
      if (cancelled) {
        codeEditorPool.release(leased);
        return;
      }
      entry = leased;
      // Reparent the pooled container into our host DOM slot. The
      // pool root keeps the entry off-screen between leases; the
      // container itself is reusable.
      try {
        host.appendChild(leased.container);
      } catch {
        // host may have been unmounted in the same tick.
      }
      leased.editor.updateOptions({ readOnly: props.readOnly ?? true });
      setEditorSignal(leased.editor);
      props.onEditorChange?.(leased.editor);
      tryAttachModel();
      installContentListener();
      leased.editor.layout();
    });
  });

  onCleanup(() => {
    cancelled = true;
    contentDisposable?.dispose();
    contentDisposable = null;
    if (lspDispose) {
      try {
        lspDispose();
      } catch {
        /* ignore */
      }
      lspDispose = null;
      lspWiredFor = undefined;
    }
    if (entry) {
      setEditorSignal(null);
      props.onEditorChange?.(null);
      try {
        entry.editor.setModel(null);
      } catch {
        /* ignore */
      }
      codeEditorPool.release(entry);
      entry = null;
      lastAttachedUri = undefined;
    }
  });

  function installContentListener() {
    const e = entry?.editor;
    if (!e) return;
    contentDisposable?.dispose();
    contentDisposable = e.onDidChangeModelContent(() => {
      if (!props.onContentChange) return;
      const value = e.getModel()?.getValue();
      if (typeof value === "string") props.onContentChange(value);
    });
  }

  // Reactive attach: re-run whenever the URI changes or the
  // registry's status for that URI flips to 'ready'.
  createEffect(() => {
    // Subscribe to the URI prop + the status signal.
    const uri = props.uri;
    const status = modelRegistry.modelStatus(uri);
    void status;
    tryAttachModel();
  });

  createEffect(() => {
    entry?.editor.updateOptions({ readOnly: props.readOnly ?? true });
  });

  function tryAttachModel() {
    const e = entry?.editor;
    if (!e) return;
    const uri = props.uri;
    if (!uri) return;
    if (modelRegistry.modelStatus(uri) !== "ready") return;
    const model = modelRegistry.getModelByUri(uri);
    if (!model) return;
    if (lastAttachedUri === uri && e.getModel() === model) return;
    // `attach` preserves view state when the buffer URI swaps; for
    // disk-only / read-only mounts it's a straight setModel.
    modelRegistry.attach(e, uri, lastAttachedUri);
    if (e.getModel() !== model) e.setModel(model);
    lastAttachedUri = uri;
    e.layout();
    syncLspWiring(e, uri);
  }

  // Tear down any previous wiring and install a fresh one for the
  // current buffer. Requires the buffer-store to have a record for
  // `uri` (the FilesSurface path always does; disk-only / preview
  // mounts skip wiring since LSP is opt-in to the live buffer).
  function syncLspWiring(
    e: monaco.editor.IStandaloneCodeEditor,
    uri: string,
  ): void {
    if (lspWiredFor === uri) return;
    if (lspDispose) {
      try {
        lspDispose();
      } catch {
        /* ignore */
      }
      lspDispose = null;
    }
    lspWiredFor = uri;
    const buffer = bufferState.buffers[uri];
    if (!buffer) {
      setActiveBufferMeta(null);
      return;
    }
    setActiveBufferMeta({
      sessionName: buffer.sessionName,
      filePath: buffer.filePath,
    });
    lspDispose = wireLspToEditor({
      editor: e,
      bufferUri: uri,
      sessionName: buffer.sessionName,
      rootPath: buffer.rootPath,
      filePath: buffer.filePath,
      language: buffer.language,
    });
  }

  const status = () => modelRegistry.modelStatus(props.uri);

  return (
    <div
      data-testid="code-editor"
      data-code-editor-uri={props.uri}
      data-code-editor-status={status()}
      class="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-[var(--bg)]"
    >
      <Show when={status() === "loading"}>
        <div
          data-testid="code-editor-loading"
          class="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg)]/80 text-[11px] text-[var(--dim)]"
        >
          loading…
        </div>
      </Show>
      <Show when={status() === "error"}>
        <div
          data-testid="code-editor-error"
          class="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg)]/80 text-[11px] text-[var(--red-foreground,var(--red))]"
        >
          failed to load file
        </div>
      </Show>
      <div ref={host} class="min-h-0 flex-1" />
      <Show when={activeBufferMeta()}>
        {(meta) => (
          <LspHoverTooltip
            editor={editorSignal}
            sessionName={meta().sessionName}
            filePath={meta().filePath}
          />
        )}
      </Show>
    </div>
  );
}
