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
        {...icon}
        className={`copy-glyph copy-glyph-copy [grid-area:1/1] ${copied ? "opacity-0" : "opacity-100"}`}
      >
        <path d="M9 15C9 12.1716 9 10.7574 9.87868 9.87868C10.7574 9 12.1716 9 15 9L16 9C18.8284 9 20.2426 9 21.1213 9.87868C22 10.7574 22 12.1716 22 15V16C22 18.8284 22 20.2426 21.1213 21.1213C20.2426 22 18.8284 22 16 22H15C12.1716 22 10.7574 22 9.87868 21.1213C9 20.2426 9 18.8284 9 16L9 15Z" />
        <path d="M16.9999 9C16.9975 6.04291 16.9528 4.51121 16.092 3.46243C15.9258 3.25989 15.7401 3.07418 15.5376 2.90796C14.4312 2 12.7875 2 9.5 2C6.21252 2 4.56878 2 3.46243 2.90796C3.25989 3.07417 3.07418 3.25989 2.90796 3.46243C2 4.56878 2 6.21252 2 9.5C2 12.7875 2 14.4312 2.90796 15.5376C3.07417 15.7401 3.25989 15.9258 3.46243 16.092C4.51121 16.9528 6.04291 16.9975 9 16.9999" />
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
