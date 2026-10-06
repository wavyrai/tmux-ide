"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { writeClipboard } from "@/lib/clipboard";

export type CopyStatus = "idle" | "copied" | "failed";

/** Copy state machine shared by copy actions: idle → copied (2s) | failed (6s). */
export function useCopy() {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (source: string | Promise<string>) => {
    const ok = await writeClipboard(source);
    setStatus(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), ok ? 2000 : 6000);
    return ok;
  }, []);

  return { status, copy };
}

/**
 * Copy and check glyphs stacked in one fixed cell, so swapping them never
 * changes the size of the control that holds them.
 */
export function CopyGlyph({ status }: { status: CopyStatus }) {
  const copied = status === "copied";
  return (
    <span aria-hidden className="grid size-4 shrink-0 place-items-center">
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        className={`copy-glyph copy-glyph-copy [grid-area:1/1] ${copied ? "opacity-0" : "opacity-100"}`}
      >
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
      </svg>
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`copy-glyph copy-glyph-check [grid-area:1/1] ${copied ? "opacity-100" : "opacity-0"}`}
      >
        {copied ? <polyline className="copy-check-path" points="20 6 9 17 4 12" /> : null}
      </svg>
    </span>
  );
}
