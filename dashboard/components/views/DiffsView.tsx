"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { fetchDiff, fetchFileDiff, type DiffData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

interface DiffsViewProps {
  sessionName: string;
}

interface DiffFile {
  file: string;
  additions: number;
  deletions: number;
}

interface RenderLine {
  raw: string;
  html: string;
  oldLine: number | null;
  newLine: number | null;
  kind: "add" | "del" | "hunk" | "meta" | "context";
}

const highlightCache = new Map<string, string[]>();

function changeCount(file: DiffFile): number {
  return file.additions + file.deletions;
}

function fileStatus(file: DiffFile): { label: string; color: string } {
  if (file.additions > 0 && file.deletions === 0) return { label: "A", color: "var(--green)" };
  if (file.additions === 0 && file.deletions > 0) return { label: "D", color: "var(--red)" };
  return { label: "M", color: "var(--yellow)" };
}

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index === -1) return { dir: "", name: path };
  return { dir: `${path.slice(0, index)}/`, name: path.slice(index + 1) };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function extractShikiLines(html: string, fallback: string[]): string[] {
  const code = html.match(/<code>([\s\S]*)<\/code>/)?.[1];
  if (!code) return fallback.map(escapeHtml);
  const lines = code.split("\n").map((line) =>
    line
      .replace(/^<span class="line">/, "")
      .replace(/<\/span>$/, "")
      .replace(/^$/, "&nbsp;"),
  );
  return lines.length === fallback.length ? lines : fallback.map(escapeHtml);
}

function parseHunkStart(line: string): { oldLine: number; newLine: number } | null {
  const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
  if (!match) return null;
  return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function buildRenderLines(raw: string, highlighted: string[]): RenderLine[] {
  const lines = raw.split("\n");
  let oldLine: number | null = null;
  let newLine: number | null = null;

  return lines.map((line, index) => {
    const hunk = parseHunkStart(line);
    if (hunk) {
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      return {
        raw: line,
        html: highlighted[index] ?? escapeHtml(line),
        oldLine: null,
        newLine: null,
        kind: "hunk",
      };
    }

    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      return {
        raw: line,
        html: highlighted[index] ?? escapeHtml(line),
        oldLine: null,
        newLine: null,
        kind: "meta",
      };
    }

    if (line.startsWith("+")) {
      const currentNew = newLine;
      if (newLine !== null) newLine += 1;
      return {
        raw: line,
        html: highlighted[index] ?? escapeHtml(line),
        oldLine: null,
        newLine: currentNew,
        kind: "add",
      };
    }

    if (line.startsWith("-")) {
      const currentOld = oldLine;
      if (oldLine !== null) oldLine += 1;
      return {
        raw: line,
        html: highlighted[index] ?? escapeHtml(line),
        oldLine: currentOld,
        newLine: null,
        kind: "del",
      };
    }

    const currentOld = oldLine;
    const currentNew = newLine;
    if (oldLine !== null) oldLine += 1;
    if (newLine !== null) newLine += 1;
    return {
      raw: line,
      html: highlighted[index] ?? escapeHtml(line || " "),
      oldLine: currentOld,
      newLine: currentNew,
      kind: "context",
    };
  });
}

function KpiCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">{label}</div>
      <div className="text-lg tabular-nums" style={{ color: color ?? "var(--fg)" }}>
        {value}
      </div>
    </div>
  );
}

function ChangeMiniBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = Math.max(1, additions + deletions);
  return (
    <div className="flex h-1.5 w-14 overflow-hidden rounded-full bg-[var(--border-weak)]">
      <div style={{ width: `${(additions / total) * 100}%`, background: "var(--green)" }} />
      <div style={{ width: `${(deletions / total) * 100}%`, background: "var(--red)" }} />
    </div>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: DiffFile;
  selected: boolean;
  onSelect: () => void;
}) {
  const { dir, name } = splitPath(file.file);
  const status = fileStatus(file);
  return (
    <button
      type="button"
      data-testid="diffs-file-row"
      onClick={onSelect}
      className={`w-full border-b border-[var(--border-weak)] px-3 py-2 text-left transition-colors ${
        selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-[var(--surface)] text-[10px]"
          style={{ color: status.color }}
        >
          {status.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px]">
          {dir && <span className="text-[var(--dim)]">{dir}</span>}
          <span className={selected ? "text-[var(--accent)]" : "text-[var(--fg)]"}>{name}</span>
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <ChangeMiniBar additions={file.additions} deletions={file.deletions} />
        <span className="ml-auto text-[10px] tabular-nums text-[var(--green)]">
          +{file.additions}
        </span>
        <span className="text-[10px] tabular-nums text-[var(--red)]">-{file.deletions}</span>
      </div>
    </button>
  );
}

function DiffPane({
  file,
  patch,
  loading,
}: {
  file: DiffFile | null;
  patch: string;
  loading: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
  const theme = resolvedTheme === "light" ? "github-light" : "github-dark";

  useEffect(() => {
    let active = true;
    const rawLines = patch.split("\n");
    if (!patch.trim()) {
      setHighlightedLines([]);
      return;
    }
    const cacheKey = `${theme}:${patch}`;
    const cached = highlightCache.get(cacheKey);
    if (cached) {
      setHighlightedLines(cached);
      return;
    }
    import("shiki")
      .then(({ codeToHtml, bundledThemes }) =>
        codeToHtml(patch, {
          lang: "diff",
          theme: theme in bundledThemes ? theme : "github-dark",
        }),
      )
      .then((html) => {
        const lines = extractShikiLines(html, rawLines);
        highlightCache.set(cacheKey, lines);
        if (active) setHighlightedLines(lines);
      })
      .catch(() => {
        if (active) setHighlightedLines(rawLines.map(escapeHtml));
      });
    return () => {
      active = false;
    };
  }, [patch, theme]);

  const renderLines = useMemo(
    () =>
      buildRenderLines(
        patch,
        highlightedLines.length > 0 ? highlightedLines : patch.split("\n").map(escapeHtml),
      ),
    [highlightedLines, patch],
  );

  if (!file) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--dim)]">
        Select a file to inspect its diff
      </div>
    );
  }

  return (
    <section data-testid="diffs-active-pane" className="flex min-w-0 flex-1 flex-col">
      <header className="flex min-h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-[var(--fg)]">{file.file}</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
            unified diff
          </div>
        </div>
        <ChangeMiniBar additions={file.additions} deletions={file.deletions} />
        <span className="text-lg tabular-nums text-[var(--green)]">+{file.additions}</span>
        <span className="text-lg tabular-nums text-[var(--red)]">-{file.deletions}</span>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-[var(--dim)]">
          loading diff...
        </div>
      ) : !patch.trim() ? (
        <div className="flex flex-1 items-center justify-center text-[var(--dim)]">
          No diff available for this file
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)] p-3">
          <pre className="min-w-max overflow-hidden rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] font-mono text-[11px] leading-5">
            {renderLines.map((line, index) => {
              const bg =
                line.kind === "add"
                  ? "var(--diff-add-bg)"
                  : line.kind === "del"
                    ? "var(--diff-del-bg)"
                    : line.kind === "hunk"
                      ? "rgba(86, 182, 194, 0.08)"
                      : "transparent";
              const color =
                line.kind === "hunk"
                  ? "var(--cyan)"
                  : line.kind === "meta"
                    ? "var(--dim)"
                    : "var(--fg)";
              return (
                <div
                  key={`${index}-${line.raw}`}
                  className="grid grid-cols-[5ch_5ch_1fr] border-b border-transparent last:border-b-0"
                  style={{ background: bg }}
                >
                  <span className="select-none border-r border-[var(--border-weak)] px-2 text-right tabular-nums text-[var(--dimmer)]">
                    {line.oldLine ?? ""}
                  </span>
                  <span className="select-none border-r border-[var(--border-weak)] px-2 text-right tabular-nums text-[var(--dimmer)]">
                    {line.newLine ?? ""}
                  </span>
                  <code
                    className="whitespace-pre px-3"
                    style={{ color }}
                    dangerouslySetInnerHTML={{ __html: line.html || "&nbsp;" }}
                  />
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </section>
  );
}

export function DiffsView({ sessionName }: DiffsViewProps) {
  const fetcher = useCallback(() => fetchDiff(sessionName), [sessionName]);
  const { data, loading, refresh } = usePolling<DiffData | null>(fetcher, 5000);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [query, setQuery] = useState("");

  const sortedFiles = useMemo(
    () =>
      [...(data?.files ?? [])].sort((a, b) => {
        const byChanges = changeCount(b) - changeCount(a);
        return byChanges !== 0 ? byChanges : a.file.localeCompare(b.file);
      }),
    [data?.files],
  );

  const filteredFiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sortedFiles;
    return sortedFiles.filter((file) => file.file.toLowerCase().includes(needle));
  }, [query, sortedFiles]);

  const activeFile = useMemo(
    () => sortedFiles.find((file) => file.file === selectedFile) ?? null,
    [selectedFile, sortedFiles],
  );

  const totals = useMemo(() => {
    const additions = sortedFiles.reduce((sum, file) => sum + file.additions, 0);
    const deletions = sortedFiles.reduce((sum, file) => sum + file.deletions, 0);
    return { additions, deletions, net: additions - deletions };
  }, [sortedFiles]);

  useEffect(() => {
    if (filteredFiles.length === 0) {
      setSelectedFile(null);
      return;
    }
    if (!selectedFile || !filteredFiles.some((file) => file.file === selectedFile)) {
      setSelectedFile(filteredFiles[0]!.file);
    }
  }, [filteredFiles, selectedFile]);

  useEffect(() => {
    if (!selectedFile) {
      setFileDiff("");
      return;
    }
    let active = true;
    setLoadingFile(true);
    fetchFileDiff(sessionName, selectedFile)
      .then((diff) => {
        if (active) setFileDiff(diff);
      })
      .catch(() => {
        if (active) setFileDiff("");
      })
      .finally(() => {
        if (active) setLoadingFile(false);
      });
    return () => {
      active = false;
    };
  }, [selectedFile, sessionName]);

  if (loading && !data) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--bg)] text-[var(--dim)]">
        Loading diffs...
      </div>
    );
  }

  if (!data || !data.diff.trim() || sortedFiles.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--bg)] p-8">
        <div className="rounded-md border border-dashed border-[var(--border-weak)] bg-[var(--bg-strong)] px-6 py-5 text-center">
          <div className="text-[13px] text-[var(--fg)]">No uncommitted changes</div>
          <div className="mt-1 text-[11px] text-[var(--dim)]">
            Working tree diffs will appear here when files change.
          </div>
          <button
            type="button"
            onClick={refresh}
            className="mt-3 rounded-sm border border-[var(--border-weak)] px-3 py-1.5 text-[11px] text-[var(--accent)] hover:bg-[var(--surface-hover)]"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]">
      <section className="grid grid-cols-2 gap-2 border-b border-[var(--border)] bg-[var(--bg)] p-4 lg:grid-cols-4">
        <KpiCard label="files changed" value={sortedFiles.length} />
        <KpiCard label="additions" value={totals.additions} color="var(--green)" />
        <KpiCard label="deletions" value={totals.deletions} color="var(--red)" />
        <KpiCard
          label="net change"
          value={totals.net}
          color={totals.net >= 0 ? "var(--green)" : "var(--red)"}
        />
      </section>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-weak)]">
          <div className="border-b border-[var(--border)] p-3">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files"
              className="h-8 w-full rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] px-3 text-[12px] text-[var(--fg)] outline-none placeholder:text-[var(--dimmer)] focus:border-[var(--accent)]"
            />
            <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
              <span>changed files</span>
              <span className="tabular-nums">{filteredFiles.length}</span>
            </div>
          </div>
          <div data-testid="diffs-file-list" className="min-h-0 flex-1 overflow-y-auto">
            {filteredFiles.length === 0 ? (
              <div className="p-3 text-[12px] text-[var(--dim)]">No files match that search.</div>
            ) : (
              filteredFiles.map((file) => (
                <FileRow
                  key={file.file}
                  file={file}
                  selected={file.file === selectedFile}
                  onSelect={() => setSelectedFile(file.file)}
                />
              ))
            )}
          </div>
        </aside>

        <DiffPane file={activeFile} patch={fileDiff} loading={loadingFile} />
      </div>
    </div>
  );
}
