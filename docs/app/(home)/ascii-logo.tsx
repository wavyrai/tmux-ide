"use client";

import { useEffect } from "react";

const ASCII_LOGO = String.raw`   ░██                                             ░██       ░██            
   ░██                                                       ░██            
░████████ ░█████████████  ░██    ░██ ░██    ░██    ░██ ░████████  ░███████  
   ░██    ░██   ░██   ░██ ░██    ░██  ░██  ░██     ░██░██    ░██ ░██    ░██ 
   ░██    ░██   ░██   ░██ ░██    ░██   ░█████      ░██░██    ░██ ░█████████ 
   ░██    ░██   ░██   ░██ ░██   ░███  ░██  ░██     ░██░██   ░███ ░██        
    ░████ ░██   ░██   ░██  ░█████░██ ░██    ░██    ░██ ░█████░██  ░███████`;

export function AsciiLogo() {
  useEffect(() => {
    console.log(
      `%c${ASCII_LOGO}`,
      "font-family: monospace; font-size: 16px; line-height: 1.1; font-weight: bold; white-space: pre;",
    );
    console.log(
      "%cCurious? Contribute at https://github.com/wavyrai/tmux-ide",
      "font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;",
    );
  }, []);

  return (
    <div
      className="select-none animate-in fade-in duration-200"
      style={{
        animationDuration: "200ms",
        animationTimingFunction: "ease-out",
      }}
    >
      <div className="font-pixel text-fd-foreground text-5xl sm:text-6xl md:text-7xl lg:text-8xl tracking-tight">
        <pre
          aria-label="tux-ide"
          className="m-0 whitespace-pre font-mono text-[0.48rem] leading-[1.02] sm:text-[0.7rem] md:text-[0.88rem] lg:text-[1.06rem]"
        >
          {ASCII_LOGO}
        </pre>
      </div>
    </div>
  );
}
