"use client";

import { PatchDiff } from "@pierre/diffs/react";
import type { CSSProperties, ReactNode } from "react";
import { useState, Component, Suspense } from "react";

// Error boundary — falls back to simple diff if PatchDiff crashes
class DiffErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

interface DiffViewerProps {
  patch: string;
  diffStyle?: "split" | "unified";
  preloaded?: any; // PreloadPatchDiffResult from SSR
}

const MAX_DIFF_LINES = 2000;

export function DiffViewer({ patch, diffStyle = "split", preloaded }: DiffViewerProps) {
  const [showFull, setShowFull] = useState(false);

  if (!patch.trim()) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        No changes
      </div>
    );
  }

  const lines = patch.split("\n");
  const truncated = lines.length > MAX_DIFF_LINES && !showFull;
  const displayDiff = truncated ? lines.slice(0, MAX_DIFF_LINES).join("\n") : patch;

  return (
    <div className="flex-1 overflow-auto">
      {truncated && (
        <div className="px-4 py-2 bg-[var(--surface)] border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-[var(--yellow)]">
            showing first {MAX_DIFF_LINES} of {lines.length} lines
          </span>
          <button
            onClick={() => setShowFull(true)}
            className="text-[var(--accent)] hover:underline"
          >
            show all
          </button>
        </div>
      )}
      <DiffErrorBoundary fallback={<SimpleDiff patch={displayDiff} />}>
        <Suspense fallback={<SimpleDiff patch={displayDiff} />}>
          {preloaded ? (
            <PatchDiff
              {...preloaded}
              className="diff-container"
            />
          ) : (
            <PatchDiff
              patch={displayDiff}
              options={{
                theme: "pierre-dark",
                diffStyle,
                diffIndicators: "bars",
                overflow: "scroll",
                themeType: "dark",
              }}
              className="diff-container"
            />
          )}
        </Suspense>
      </DiffErrorBoundary>
    </div>
  );
}

// Simple fallback diff renderer — always works, no dependencies
function SimpleDiff({ patch }: { patch: string }) {
  const lines = patch.split("\n").slice(0, 500);
  return (
    <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        let color = "var(--fg)";
        let bg = "transparent";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          color = "var(--green)";
          bg = "rgba(125,216,125,0.08)";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          color = "var(--red)";
          bg = "rgba(247,118,142,0.08)";
        } else if (line.startsWith("@@")) {
          color = "var(--cyan)";
        } else if (line.startsWith("diff ") || line.startsWith("index ")) {
          color = "var(--dim)";
        }
        return (
          <div key={i} style={{ color, background: bg, whiteSpace: "pre" }}>
            {line || " "}
          </div>
        );
      })}
      {lines.length >= 500 && (
        <div style={{ color: "var(--yellow)", padding: "8px 0" }}>
          ... truncated at 500 lines
        </div>
      )}
    </div>
  );
}
