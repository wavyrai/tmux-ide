"use client";

import { useState, useEffect } from "react";

const LOGO = `      _____                    _____                    _____                                                    _____                    _____                    _____
     /\\    \\                  /\\    \\                  /\\    \\                 ______                           /\\    \\                  /\\    \\                  /\\    \\
    /::\\    \\                /::\\____\\                /::\\____\\               |::|   |                         /::\\    \\                /::\\    \\                /::\\    \\
    \\:::\\    \\              /::::|   |               /:::/    /               |::|   |                         \\:::\\    \\              /::::\\    \\              /::::\\    \\
     \\:::\\    \\            /:::::|   |              /:::/    /                |::|   |                          \\:::\\    \\            /::::::\\    \\            /::::::\\    \\
      \\:::\\    \\          /::::::|   |             /:::/    /                 |::|   |                           \\:::\\    \\          /:::/\\:::\\    \\          /:::/\\:::\\    \\
       \\:::\\    \\        /:::/|::|   |            /:::/    /                  |::|   |                            \\:::\\    \\        /:::/  \\:::\\    \\        /:::/__\\:::\\    \\
       /::::\\    \\      /:::/ |::|   |           /:::/    /                   |::|   |                            /::::\\    \\      /:::/    \\:::\\    \\      /::::\\   \\:::\\    \\
      /::::::\\    \\    /:::/  |::|___|______    /:::/    /      _____         |::|   |                   ____    /::::::\\    \\    /:::/    / \\:::\\    \\    /::::::\\   \\:::\\    \\
     /:::/\\:::\\    \\  /:::/   |::::::::\\    \\  /:::/____/      /\\    \\  ______|::|___|___ ____          /\\   \\  /:::/\\:::\\    \\  /:::/    /   \\:::\\ ___\\  /:::/\\:::\\   \\:::\\    \\
    /:::/  \\:::\\____\\/:::/    |:::::::::\\____\\|:::|    /      /::\\____\\|:::::::::::::::::|    |        /::\\   \\/:::/  \\:::\\____\\/:::/____/     \\:::|    |/:::/__\\:::\\   \\:::\\____\\
   /:::/    \\::/    /\\::/    / ~~~~~/:::/    /|:::|____\\     /:::/    /|:::::::::::::::::|____|        \\:::\\  /:::/    \\::/    /\\:::\\    \\     /:::|____|\\:::\\   \\:::\\   \\::/    /
  /:::/    / \\/____/  \\/____/      /:::/    /  \\:::\\    \\   /:::/    /  ~~~~~~|::|~~~|~~~               \\:::\\/:::/    / \\/____/  \\:::\\    \\   /:::/    /  \\:::\\   \\:::\\   \\/____/
 /:::/    /                       /:::/    /    \\:::\\    \\ /:::/    /         |::|   |                   \\::::::/    /            \\:::\\    \\ /:::/    /    \\:::\\   \\:::\\    \\
/:::/    /                       /:::/    /      \\:::\\    /:::/    /          |::|   |                    \\::::/____/              \\:::\\    /:::/    /      \\:::\\   \\:::\\____\\
\\::/    /                       /:::/    /        \\:::\\__/:::/    /           |::|   |                     \\:::\\    \\               \\:::\\  /:::/    /        \\:::\\   \\::/    /
 \\/____/                       /:::/    /          \\::::::::/    /            |::|   |                      \\:::\\    \\               \\:::\\/:::/    /          \\:::\\   \\/____/
                              /:::/    /            \\::::::/    /             |::|   |                       \\:::\\    \\               \\::::::/    /            \\:::\\    \\
                             /:::/    /              \\::::/    /              |::|   |                        \\:::\\____\\               \\::::/    /              \\:::\\____\\
                             \\::/    /                \\::/____/               |::|___|                         \\::/    /                \\::/____/                \\::/    /
                              \\/____/                  ~~                      ~~                               \\/____/                  ~~                       \\/____/`;

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
        className="font-mono whitespace-pre select-none text-center text-[3.5px] sm:text-[5px] md:text-[7px] lg:text-[9px] xl:text-[10px] leading-[1.1]"
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
