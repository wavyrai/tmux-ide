"use client";

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
}

export function MarkdownEditor({ value, onChange, onSave }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!hostRef.current) return;

    const startState = EditorState.create({
      doc: value,
      extensions: [
        history(),
        lineNumbers(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        oneDark,
        EditorView.lineWrapping,
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "13px",
            fontFamily: "var(--font-mono)",
            backgroundColor: "transparent",
          },
          ".cm-scroller": {
            fontFamily: "var(--font-mono)",
          },
          ".cm-content": {
            paddingTop: "12px",
            paddingBottom: "12px",
          },
          ".cm-gutters": {
            backgroundColor: "transparent",
            borderRight: "1px solid var(--border-weak)",
          },
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: (v) => {
              onSaveRef.current(v.state.doc.toString());
              return true;
            },
          },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    viewRef.current = new EditorView({ state: startState, parent: hostRef.current });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // value is the initial doc only — controlled updates happen via the
    // dispatched 'tmux-ide:set-markdown' event, so changing the prop
    // doesn't recreate the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External "set markdown" event (fired when reload-from-disk happens).
  useEffect(() => {
    const root = hostRef.current;
    if (!root) return;
    function onSetMarkdown(event: Event) {
      const next = (event as CustomEvent<string>).detail;
      const view = viewRef.current;
      if (typeof next !== "string" || !view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    }
    root.addEventListener("tmux-ide:set-markdown", onSetMarkdown);
    return () => root.removeEventListener("tmux-ide:set-markdown", onSetMarkdown);
  }, []);

  return (
    <div
      ref={hostRef}
      data-testid="markdown-editor"
      className="flex-1 min-h-0 overflow-auto"
    />
  );
}
