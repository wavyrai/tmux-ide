"use client";

import type { AuthorshipData } from "@/lib/api";

interface AuthorshipBarProps {
  authorship: AuthorshipData | null;
}

export function AuthorshipBar({ authorship }: AuthorshipBarProps) {
  if (!authorship) {
    return <div className="text-[10px] text-[var(--dim)] px-1 py-1">No authorship data</div>;
  }

  const { aiPercent, humanPercent, totalChars } = authorship.stats;

  return (
    <div className="flex items-center gap-3 px-1 py-1.5">
      {/* Bar */}
      <div className="flex h-1.5 flex-1 overflow-hidden rounded-sm">
        {aiPercent > 0 && (
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${aiPercent}%`,
              backgroundColor: "var(--ai-color)",
              opacity: 0.6,
            }}
          />
        )}
        {humanPercent > 0 && (
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${humanPercent}%`,
              backgroundColor: "var(--human-color)",
              opacity: 0.6,
            }}
          />
        )}
      </div>

      {/* Label */}
      <span className="text-[10px] shrink-0 flex gap-2">
        <span style={{ color: "var(--ai-color)" }}>{aiPercent}% AI</span>
        <span className="text-[var(--dim)]">/</span>
        <span style={{ color: "var(--human-color)" }}>{humanPercent}% human</span>
        <span className="text-[var(--dimmer)]">({Math.round(totalChars / 1000)}k chars)</span>
      </span>
    </div>
  );
}
