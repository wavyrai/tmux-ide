"use client";

import { useEffect, useRef, useCallback } from "react";
import { Editor, defaultValueCtx, rootCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { nord } from "@milkdown/theme-nord";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import { getMarkdown } from "@milkdown/utils";
import "@milkdown/theme-nord/style.css";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
}

function MilkdownEditor({ value, onChange, onSave }: MarkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEditor((root) => {
    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, value);
      })
      .config(nord)
      .use(commonmark);
  }, []);

  const [loading, getInstance] = useInstance();

  // Extract markdown on changes via MutationObserver on ProseMirror
  const containerRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);

  const extractMarkdown = useCallback(() => {
    if (loading) return;
    const editor = getInstance();
    if (!editor) return;
    try {
      const md = editor.action(getMarkdown() as any) as string;
      onChangeRef.current(md);
    } catch {
      // Editor may not be ready
    }
  }, [loading, getInstance]);

  useEffect(() => {
    const el = containerRef.current?.querySelector(".ProseMirror");
    if (!el) return;

    observerRef.current = new MutationObserver(() => {
      extractMarkdown();
    });

    observerRef.current.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      observerRef.current?.disconnect();
    };
  }, [loading, extractMarkdown]);

  // Ctrl+S / Cmd+S
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (loading) return;
        const editor = getInstance();
        if (!editor) return;
        try {
          const md = editor.action(getMarkdown() as any) as string;
          onSaveRef.current(md);
        } catch {
          // ignore
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, getInstance]);

  return (
    <div ref={containerRef} className="milkdown-wrap flex-1 min-h-0 overflow-auto">
      <Milkdown />
    </div>
  );
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownEditor {...props} />
    </MilkdownProvider>
  );
}
