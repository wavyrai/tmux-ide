"use client";

import { useState, useEffect } from "react";

const LOGO = ` _                                _     _
| |_ _ __ ___  _   ___  __      (_) __| | ___
| __| '_ \` _ \\| | | \\ \\/ /_____ | |/ _\` |/ _ \\
| |_| | | | | | |_| |>  <|_____|| | (_| |  __/
 \\__|_| |_| |_|\\__,_/_/\\_\\      |_|\\__,_|\\___|`;

const TOTAL_CHARS = LOGO.length;
const CHAR_DELAY = 15;
const FADE_DELAY = 400;

export function AsciiLogo() {
  const [charCount, setCharCount] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (charCount >= TOTAL_CHARS) {
      const timeout = setTimeout(() => setDone(true), FADE_DELAY);
      return () => clearTimeout(timeout);
    }
    const timeout = setTimeout(() => setCharCount((c) => c + 1), CHAR_DELAY);
    return () => clearTimeout(timeout);
  }, [charCount]);

  const visible = LOGO.slice(0, charCount);

  return (
    <pre
      className={`text-[10px] sm:text-xs md:text-sm leading-[1.15] select-none transition-colors duration-700 ${
        done ? "text-fd-foreground" : "text-emerald-400"
      }`}
      aria-label="tmux-ide"
    >
      {visible}
      {!done && <span className="animate-pulse">_</span>}
    </pre>
  );
}
