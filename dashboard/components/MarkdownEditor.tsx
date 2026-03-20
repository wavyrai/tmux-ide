"use client";

import { useRef, useEffect, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
}

// Custom theme overrides to match dashboard CSS variables
const dashboardTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    fontSize: "13px",
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    lineHeight: "1.5",
    padding: "8px 0",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--accent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--surface-active) !important",
  },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--dimmer)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--surface-active)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--surface-hover)",
  },
  ".cm-line": {
    padding: "0 8px",
  },
});

export function MarkdownEditor({ value, onChange, onSave }: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  onSaveRef.current = onSave;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        run: (view) => {
          onSaveRef.current(view.state.doc.toString());
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        saveKeymap,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        markdown(),
        oneDark,
        dashboardTheme,
        syntaxHighlighting(defaultHighlightStyle),
        updateListener,
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only create once — value changes handled by parent remounting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
    />
  );
}
