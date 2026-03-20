"use client";

import { useState, useCallback, useMemo } from "react";
import { fetchDiff, type DiffData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { DiffViewer } from "./DiffViewer";
import { FileList } from "./FileList";

interface DiffPanelProps {
  sessionName: string;
}

/**
 * Extract the patch for a single file from a full multi-file git diff.
 * Splits on 'diff --git' boundaries and returns the matching section.
 */
function extractFilePatch(fullDiff: string, fileName: string): string {
  const sections = fullDiff.split(/(?=^diff --git )/m);
  for (const section of sections) {
    // Match 'diff --git a/path b/path' — the file appears in the b/ side
    if (
      section.includes(`b/${fileName}`) ||
      section.includes(`a/${fileName}`)
    ) {
      return section;
    }
  }
  return "";
}

export function DiffPanel({ sessionName }: DiffPanelProps) {
  const fetcher = useCallback(
    () => fetchDiff(sessionName),
    [sessionName],
  );
  const { data, loading } = usePolling<DiffData | null>(fetcher, 5000);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");

  const visiblePatch = useMemo(() => {
    if (!data?.diff) return "";
    if (!selectedFile) return data.diff;
    return extractFilePatch(data.diff, selectedFile);
  }, [data, selectedFile]);

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        Loading diffs…
      </div>
    );
  }

  if (!data || !data.diff.trim()) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        No uncommitted changes
      </div>
    );
  }

  const totalAdditions = data.files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = data.files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center h-7 px-3 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <span className="text-[var(--dim)]">
          {data.files.length} file{data.files.length !== 1 ? "s" : ""} changed
        </span>
        <span className="mx-2 text-[var(--dim)] opacity-30">│</span>
        <span className="text-[var(--green)]">+{totalAdditions}</span>
        <span className="mx-1 text-[var(--dim)] opacity-30">/</span>
        <span className="text-[var(--red)]">-{totalDeletions}</span>
        <span className="flex-1" />
        <div className="flex border border-[var(--border)] rounded overflow-hidden">
          <button
            onClick={() => setDiffStyle("split")}
            className={`px-2 h-5 text-[11px] transition-colors ${
              diffStyle === "split"
                ? "bg-[rgba(255,255,255,0.06)] text-[var(--fg)]"
                : "text-[var(--dim)] hover:text-[var(--fg)]"
            }`}
          >
            split
          </button>
          <button
            onClick={() => setDiffStyle("unified")}
            className={`px-2 h-5 text-[11px] transition-colors ${
              diffStyle === "unified"
                ? "bg-[rgba(255,255,255,0.06)] text-[var(--fg)]"
                : "text-[var(--dim)] hover:text-[var(--fg)]"
            }`}
          >
            unified
          </button>
        </div>
      </div>

      {/* Content: file list + diff viewer */}
      <div className="flex flex-1 min-h-0">
        {/* File sidebar */}
        <div className="w-[260px] shrink-0 border-r border-[var(--border)] overflow-y-auto">
          <FileList
            files={data.files}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
          />
        </div>

        {/* Diff viewer */}
        <DiffViewer patch={visiblePatch} diffStyle={diffStyle} />
      </div>
    </div>
  );
}
