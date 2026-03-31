"use client";

import { useState, useEffect } from "react";

const LOGO = `                  ___           ___           ___                               _____          ___
      ___        /__/\\         /__/\\         /__/|                 ___         /  /::\\        /  /\\
     /  /\\      |  |::\\        \\  \\:\\       |  |:|                /  /\\       /  /:/\\:\\      /  /:/_
    /  /:/      |  |:|:\\        \\  \\:\\      |  |:|               /  /:/      /  /:/  \\:\\    /  /:/ /\\
   /  /:/     __|__|:|\\:\\   ___  \\  \\:\\   __|__|:|              /__/::\\     /__/:/ \\__\\:|  /  /:/ /:/_
  /  /::\\    /__/::::| \\:\\ /__/\\  \\__\\:\\ /__/::::\\____          \\__\\/\\:\\__  \\  \\:\\ /  /:/ /__/:/ /:/ /\\
 /__/:/\\:\\   \\  \\:\\~~\\__\\/ \\  \\:\\ /  /:/    ~\\~~\\::::/             \\  \\:\\/\\  \\  \\:\\  /:/  \\  \\:\\/:/ /:/
 \\__\\/  \\:\\   \\  \\:\\        \\  \\:\\  /:/      |~~|:|~~               \\__\\::/   \\  \\:\\/:/    \\  \\::/ /:/
      \\  \\:\\   \\  \\:\\        \\  \\:\\/:/       |  |:|                 /__/:/     \\  \\::/      \\  \\:\\/:/
       \\__\\/    \\  \\:\\        \\  \\::/        |  |:|                 \\__\\/       \\__\\/        \\  \\::/
                 \\__\\/         \\__\\/         |__|/                                            \\__\\/    `;

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
      "%c\uD83E\uDD16 Built with Claude Code — from architecture to landing page, orchestrated by tmux-ide missions.",
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
        className="font-mono whitespace-pre select-none text-center text-[5px] sm:text-[7px] md:text-[9px] lg:text-xs leading-[1.1]"
        style={{
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
