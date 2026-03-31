"use client";

import { useState, useEffect } from "react";

const LOGO = ` _                                _     _
| |_ _ __ ___  _   ___  __      (_) __| | ___
| __| '_ \` _ \\| | | \\ \\/ /_____ | |/ _\` |/ _ \\
| |_| | | | | | |_| |>  <|_____|| | (_| |  __/
 \\__|_| |_| |_|\\__,_/_/\\_\\      |_|\\__,_|\\___|`;

const TOTAL_CHARS = LOGO.length;
const CHAR_DELAY = 1;
const PULSE_DELAY = 50;
const SETTLE_DELAY = 600;

export function AsciiLogo() {
  const [charCount, setCharCount] = useState(0);
  const [phase, setPhase] = useState<"typing" | "pulse" | "settled">("typing");

  useEffect(() => {
    if (charCount >= TOTAL_CHARS) {
      const t1 = setTimeout(() => setPhase("pulse"), PULSE_DELAY);
      const t2 = setTimeout(() => setPhase("settled"), PULSE_DELAY + SETTLE_DELAY);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
    const timeout = setTimeout(() => setCharCount((c) => c + 1), CHAR_DELAY);
    return () => clearTimeout(timeout);
  }, [charCount]);

  const visible = LOGO.slice(0, charCount);

  return (
    <pre
      className={[
        "text-[10px] sm:text-xs md:text-sm leading-[1.15] select-none origin-left",
        "transition-all",
        phase === "typing" ? "text-emerald-400 duration-0" : "",
        phase === "pulse"
          ? "text-emerald-300 scale-[1.02] duration-150"
          : "",
        phase === "settled" ? "text-fd-foreground scale-100 duration-700" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="tmux-ide"
    >
      {visible}
      {phase === "typing" && <span className="animate-pulse">_</span>}
    </pre>
  );
}
