"use client";

import { PatchDiff } from "@pierre/diffs/react";
import type { CSSProperties } from "react";

interface DiffViewerProps {
  patch: string;
  diffStyle?: "split" | "unified";
}

const containerStyle: CSSProperties = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "1.5",
  "--diffs-font-family": "'IBM Plex Mono', ui-monospace, monospace",
} as CSSProperties;

export function DiffViewer({ patch, diffStyle = "split" }: DiffViewerProps) {
  if (!patch.trim()) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        No changes
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto" style={containerStyle}>
      <PatchDiff
        patch={patch}
        options={{
          theme: "tokyo-night",
          diffStyle,
          diffIndicators: "bars",
          overflow: "scroll",
          themeType: "dark",
        }}
      />
    </div>
  );
}
