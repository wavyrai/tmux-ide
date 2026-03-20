"use client";

import { useState, useEffect } from "react";
import { ThemeToggle } from "./ThemeToggle";

export function TopBar() {
  const [time, setTime] = useState("");

  useEffect(() => {
    function update() {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    }
    update();
    const id = setInterval(update, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="h-6 flex items-center px-3 bg-[var(--bg-weak)] border-b text-[11px] sticky top-0 z-30">
      <span className="text-[var(--accent)] font-medium">tmux-ide</span>
      <span className="flex-1" />
      <ThemeToggle />
      <span className="text-[var(--dim)] ml-3">{time}</span>
    </div>
  );
}
