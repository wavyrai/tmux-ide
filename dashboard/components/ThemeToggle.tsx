"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Avoid hydration mismatch — render nothing until mounted
  if (!mounted) return <span className="w-4" />;

  const isDark = theme === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? "☀" : "☾"}
    </button>
  );
}
