"use client";

import { useState, useCallback, useEffect } from "react";
import { fetchDiff, fetchFileDiff, type DiffData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { DiffViewer } from "./DiffViewer";
import { FileList } from "./FileList";

interface DiffPanelProps {
  sessionName: string;
}

export function DiffPanel({ sessionName }: DiffPanelProps) {
  const fetcher = useCallback(() => fetchDiff(sessionName), [sessionName]);
  const { data, loading } = usePolling<DiffData | null>(fetcher, 5000);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string>("");
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");
  const [loadingFile, setLoadingFile] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  // Fetch per-file diff when selection changes
  useEffect(() => {
    if (!selectedFile) {
      setFileDiff("");
      return;
    }
    setLoadingFile(true);
    fetchFileDiff(sessionName, selectedFile)
      .then((diff) => setFileDiff(diff))
      .catch(() => setFileDiff(""))
      .finally(() => setLoadingFile(false));
  }, [selectedFile, sessionName]);

  // PatchDiff requires exactly 1 file diff — only show when a file is selected
  const visiblePatch = selectedFile ? fileDiff : "";

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
                ? "bg-[var(--surface-active)] text-[var(--fg)]"
                : "text-[var(--dim)] hover:text-[var(--fg)]"
            }`}
          >
            split
          </button>
          <button
            onClick={() => setDiffStyle("unified")}
            className={`px-2 h-5 text-[11px] transition-colors ${
              diffStyle === "unified"
                ? "bg-[var(--surface-active)] text-[var(--fg)]"
                : "text-[var(--dim)] hover:text-[var(--fg)]"
            }`}
          >
            unified
          </button>
        </div>
      </div>

      {/* Content: file list + diff viewer */}
      <div className="flex flex-1 min-h-0 min-w-0">
        {/* File sidebar */}
        <div
          className={`${mobileDetailOpen ? "hidden" : "block"} w-full shrink-0 overflow-y-auto border-r border-[var(--border)] md:block md:w-[260px]`}
        >
          <FileList
            files={data.files}
            selectedFile={selectedFile}
            onSelectFile={(file) => {
              setSelectedFile(file);
              setMobileDetailOpen(true);
            }}
          />
        </div>

        {/* Diff viewer — min-w-0 lets the flex child shrink below intrinsic
            width of the patch content so split-mode doesn't push past the
            viewport. */}
        <div
          className={`${mobileDetailOpen ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col md:flex`}
        >
          <div className="flex h-9 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-weak)] px-2 md:hidden">
            <button
              type="button"
              onClick={() => setMobileDetailOpen(false)}
              className="flex h-7 items-center gap-1 px-2 text-[12px] text-[var(--fg-secondary)] hover:text-[var(--accent)]"
              aria-label="Back to files"
            >
              ‹ files
            </button>
          </div>
          {selectedFile && visiblePatch ? (
            <DiffViewer patch={visiblePatch} diffStyle={diffStyle} />
          ) : loadingFile ? (
            <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
              loading diff...
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
              select a file to view diff
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
