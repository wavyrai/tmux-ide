"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SPRITE } from "@/components/icons/sprite-url";
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
 * changes the size of the control that holds them. Icons: Hugeicons free set
 * (MIT), copy-01 and tick-02; see docs/THIRD_PARTY_NOTICES.md.
 */
export function CopyGlyph({ status, size = 16 }: { status: CopyStatus; size?: number }) {
  const copied = status === "copied";
  const icon = {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        aria-hidden
        className={`copy-glyph copy-glyph-copy [grid-area:1/1] ${copied ? "opacity-0" : "opacity-100"}`}
      >
        <use href={`${SPRITE}#copy`} />
      </svg>
      <svg
        {...icon}
        className={`copy-glyph copy-glyph-check [grid-area:1/1] ${copied ? "opacity-100" : "opacity-0"}`}
      >
        {copied ? <path className="copy-check-path" d="M5 14L8.5 17.5L19 6.5" /> : null}
      </svg>
    </span>
  );
}
