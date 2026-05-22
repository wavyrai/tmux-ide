/**
 * Solid-rendered hover tooltip backed by the daemon LSP /lsp/hover
 * endpoint. Disables Monaco's built-in hover widget for the leased
 * editor (so the two don't fight) and instead listens to
 * `editor.onMouseMove` with a small debounce; when the cursor
 * settles over a word, POSTs to the daemon and renders the resulting
 * markdown body in a floating Solid overlay anchored to the hovered
 * line.
 *
 * The overlay is intentionally minimal: code fences are rendered as
 * `<pre>` blocks; everything else falls through as plain text. The
 * raw LSP markup string is preserved in a `data-` attribute for test
 * assertions.
 */

import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import type * as monaco from "monaco-editor";
import { lspHover, type LspHover, type LspHoverContents } from "@/lib/lsp/api";

const HOVER_DEBOUNCE_MS = 350;

export interface LspHoverTooltipProps {
  /** Solid accessor — null until the leased editor mounts. */
  editor: () => monaco.editor.IStandaloneCodeEditor | null;
  /** tmux-ide session name — used in the LSP endpoint path. */
  sessionName: string;
  /** Workspace-relative file path — the daemon sandbox treats it as
   *  rooted under the session directory. */
  filePath: string;
}

interface HoverPayload {
  /** Editor-content-area pixel coords for the anchor point. */
  left: number;
  top: number;
  markdown: string;
}

function hoverContentsToMarkdown(contents: LspHoverContents): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "value" in c) {
          if (c.language) return "```" + c.language + "\n" + c.value + "\n```";
          return c.value;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (contents && typeof contents === "object" && "value" in contents) {
    return contents.value;
  }
  return "";
}

/** Tiny "markdown" → JSX tokenizer.
 *  Recognises fenced ```code``` blocks and renders them as <pre>;
 *  everything else is preserved as wrapped text. */
function renderMarkdown(markdown: string): JSX.Element {
  const blocks: Array<{ kind: "code" | "text"; value: string }> = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown))) {
    if (m.index > last) {
      const text = markdown.slice(last, m.index).trim();
      if (text) blocks.push({ kind: "text", value: text });
    }
    blocks.push({ kind: "code", value: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < markdown.length) {
    const text = markdown.slice(last).trim();
    if (text) blocks.push({ kind: "text", value: text });
  }
  if (blocks.length === 0 && markdown.trim()) {
    blocks.push({ kind: "text", value: markdown });
  }
  return (
    <For each={blocks}>
      {(block) =>
        block.kind === "code" ? (
          <pre class="m-0 whitespace-pre-wrap break-words font-mono text-sm text-[var(--fg)]">
            {block.value}
          </pre>
        ) : (
          <p class="m-0 whitespace-pre-wrap text-sm text-[var(--fg)]">{block.value}</p>
        )
      }
    </For>
  );
}

export function LspHoverTooltip(props: LspHoverTooltipProps): JSX.Element {
  const [hover, setHover] = createSignal<HoverPayload | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let lastKey = "";
  const disposables: monaco.IDisposable[] = [];

  function cancel(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    abortController?.abort();
    abortController = null;
  }

  function dismiss(): void {
    cancel();
    lastKey = "";
    setHover(null);
  }

  function schedule(
    editor: monaco.editor.IStandaloneCodeEditor,
    position: monaco.Position,
    target: monaco.editor.IMouseTarget,
  ): void {
    const model = editor.getModel();
    if (!model) return;
    const word = model.getWordAtPosition(position);
    if (!word) {
      dismiss();
      return;
    }
    const key = `${model.uri.toString()}::${position.lineNumber}:${word.startColumn}:${word.endColumn}`;
    if (key === lastKey) return;
    cancel();
    const dom = target.element?.getBoundingClientRect();
    const host = editor.getDomNode()?.getBoundingClientRect();
    if (!dom || !host) return;
    debounceTimer = setTimeout(() => {
      void runHover({ editor, position, word, key, host });
    }, HOVER_DEBOUNCE_MS);
  }

  async function runHover(args: {
    editor: monaco.editor.IStandaloneCodeEditor;
    position: monaco.Position;
    word: monaco.editor.IWordAtPosition;
    key: string;
    host: DOMRect;
  }): Promise<void> {
    abortController = new AbortController();
    const controller = abortController;
    let result: { hover: LspHover | null };
    try {
      result = await lspHover(
        props.sessionName,
        {
          file: props.filePath,
          // LSP positions are 0-based on both axes.
          line: args.position.lineNumber - 1,
          column: args.word.startColumn - 1,
        },
        controller.signal,
      );
    } catch {
      if (controller.signal.aborted) return;
      dismiss();
      return;
    }
    if (controller.signal.aborted) return;
    const markdown = result.hover ? hoverContentsToMarkdown(result.hover.contents) : "";
    if (!markdown.trim()) {
      dismiss();
      return;
    }
    const anchor = args.editor.getScrolledVisiblePosition({
      lineNumber: args.position.lineNumber,
      column: args.word.startColumn,
    });
    if (!anchor) {
      dismiss();
      return;
    }
    // Offset the tooltip a few px below the anchored line so the
    // user's cursor doesn't sit on top of it.
    setHover({
      left: anchor.left,
      top: anchor.top + anchor.height + 4,
      markdown,
    });
    lastKey = args.key;
  }

  createEffect(() => {
    const editor = props.editor();
    if (!editor) return;
    editor.updateOptions({ hover: { enabled: false } });
    disposables.push(
      editor.onMouseMove((e) => {
        const position = e.target.position;
        if (!position) {
          dismiss();
          return;
        }
        schedule(editor, position, e.target);
      }),
    );
    disposables.push(editor.onMouseLeave(() => dismiss()));
    disposables.push(editor.onDidScrollChange(() => dismiss()));
    disposables.push(editor.onDidChangeModel(() => dismiss()));
    disposables.push(editor.onDidChangeModelContent(() => dismiss()));
    onCleanup(() => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      disposables.length = 0;
      cancel();
      try {
        editor.updateOptions({ hover: { enabled: true } });
      } catch {
        /* editor already disposed */
      }
    });
  });

  onCleanup(() => cancel());

  return (
    <Show when={hover()}>
      {(payload) => (
        <div
          data-testid="lsp-hover-tooltip"
          data-hover-markdown={payload().markdown}
          class="pointer-events-none absolute z-30 max-w-[420px] rounded border border-[var(--border)] bg-[var(--bg-strong)] px-2 py-1 shadow-lg"
          style={{
            left: `${payload().left}px`,
            top: `${payload().top}px`,
          }}
        >
          <div class="flex flex-col gap-1">{renderMarkdown(payload().markdown)}</div>
        </div>
      )}
    </Show>
  );
}
