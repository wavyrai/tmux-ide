"use client";

import { useState, useEffect } from "react";

const LOGO = `
 ████████ ██     ██ ██    ██ ██   ██         ██ ██████  ███████
    ██    ███   ███ ██    ██  ██ ██          ██ ██   ██ ██
    ██    ████ ████ ██    ██   ███   ██████  ██ ██   ██ █████
    ██    ██ ███ ██ ██    ██  ██ ██          ██ ██   ██ ██
    ██    ██     ██  ██████  ██   ██         ██ ██████  ███████`.trimStart();

export function AsciiLogo() {
  const [phase, setPhase] = useState<"hidden" | "visible" | "settled">("hidden");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("visible"), 200);
    const t2 = setTimeout(() => setPhase("settled"), 700);

    // Console greeting
    console.log(
      "%c" + LOGO,
      "color: #34d399; font-family: monospace; font-size: 10px;",
    );
    console.log(
      "%c\uD83E\uDD16 Built with Claude Code \u2014 from architecture to landing page, orchestrated by tmux-ide missions.",
      "color: #a78bfa; font-size: 12px; font-family: system-ui;",
    );
    console.log(
      "%cEvery feature on this page was planned, dispatched, and validated by autonomous agents.",
      "color: #64748b; font-size: 11px; font-family: system-ui;",
    );

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div className="overflow-x-auto w-full">
      <pre
        className="whitespace-pre select-none text-center leading-none text-[7px] sm:text-[9px] md:text-xs lg:text-sm xl:text-base"
        style={{
          fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, monospace",
          fontVariantLigatures: "none",
          fontFeatureSettings: '"liga" 0, "calt" 0',
          opacity: phase === "hidden" ? 0 : 1,
          transition: "opacity 300ms ease-out, text-shadow 400ms ease-out",
          color: phase === "settled" ? "var(--fd-foreground)" : undefined,
          textShadow:
            phase === "visible"
              ? "0 0 12px rgba(52, 211, 153, 0.6), 0 0 4px rgba(52, 211, 153, 0.3)"
              : phase === "settled"
                ? "0 0 4px rgba(52, 211, 153, 0.15)"
                : "none",
        }}
        aria-label="tmux-ide"
      >
        <span className={phase === "settled" ? "text-fd-foreground" : "text-emerald-400/80"}>
          {LOGO}
        </span>
      </pre>
    </div>
  );
}
