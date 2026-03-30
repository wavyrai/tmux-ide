"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Markdown from "react-markdown";
import {
  fetchPlans,
  fetchPlan,
  savePlan,
  markPlanDone,
  type PlanSummary,
  type PlanData,
  type PlanStatus,
  type AuthorshipData,
} from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { AuthorshipBar } from "./AuthorshipBar";
import { MarkdownEditor } from "./MarkdownEditor";

interface PlansPanelProps {
  sessionName: string;
}

const STATUS_ICONS: Record<PlanStatus, string> = {
  "in-progress": "●",
  pending: "○",
  done: "✓",
  archived: "▪",
};

const STATUS_COLORS: Record<PlanStatus, string> = {
  "in-progress": "var(--yellow)",
  pending: "var(--dim)",
  done: "var(--green)",
  archived: "var(--dimmer)",
};

interface MarkdownSection {
  heading: string;
  content: string;
  author: string | null;
  authorAt: string | null;
}

function splitIntoSections(markdown: string, authorship: AuthorshipData | null): MarkdownSection[] {
  const lines = markdown.split("\n");
  const sections: MarkdownSection[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      if (currentLines.length > 0 || currentHeading) {
        const sectionAuth = authorship?.sections[currentHeading] ?? null;
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n"),
          author: sectionAuth?.author ?? null,
          authorAt: sectionAuth?.at ?? null,
        });
      }
      currentHeading = headingMatch[1]!.trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentHeading) {
    const sectionAuth = authorship?.sections[currentHeading] ?? null;
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n"),
      author: sectionAuth?.author ?? null,
      authorAt: sectionAuth?.at ?? null,
    });
  }

  return sections;
}

function isAiAuthor(author: string | null): boolean {
  if (!author) return false;
  return author.startsWith("ai");
}

function formatAuthorTime(at: string | null): string {
  if (!at) return "";
  try {
    const d = new Date(at);
    const ms = Date.now() - d.getTime();
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  } catch {
    return "";
  }
}

export function PlansPanel({ sessionName }: PlansPanelProps) {
  const fetcher = useCallback(() => fetchPlans(sessionName), [sessionName]);
  const { data: plans, loading, refresh: refreshPlans } = usePolling<PlanSummary[]>(fetcher, 10000);

  const [statusFilter, setStatusFilter] = useState<PlanStatus | "all">("all");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [planData, setPlanData] = useState<PlanData>({ content: "", authorship: null });
  const [loadingContent, setLoadingContent] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  const filteredPlans = useMemo(() => {
    if (!plans) return [];
    if (statusFilter === "all") return plans;
    return plans.filter((p) => p.status === statusFilter);
  }, [plans, statusFilter]);

  const selectedPlan = useMemo(
    () => plans?.find((p) => p.path === selectedFile) ?? null,
    [plans, selectedFile],
  );

  useEffect(() => {
    if (!selectedFile) {
      setPlanData({ content: "", authorship: null });
      setEditing(false);
      return;
    }
    setLoadingContent(true);
    setEditing(false);
    fetchPlan(sessionName, selectedFile)
      .then((d) => {
        setPlanData(d);
        setEditContent(d.content);
      })
      .catch(() => setPlanData({ content: "", authorship: null }))
      .finally(() => setLoadingContent(false));
  }, [selectedFile, sessionName]);

  useEffect(() => {
    if (!selectedFile && filteredPlans.length > 0) {
      setSelectedFile(filteredPlans[0]!.path);
    }
  }, [filteredPlans, selectedFile]);

  const sections = useMemo(
    () => splitIntoSections(planData.content, planData.authorship),
    [planData],
  );

  async function handleSave(content: string) {
    if (!selectedFile) return;
    setSaving(true);
    const ok = await savePlan(sessionName, selectedFile, content);
    if (ok) {
      const d = await fetchPlan(sessionName, selectedFile);
      setPlanData(d);
      setEditContent(d.content);
      setEditing(false);
    }
    setSaving(false);
  }

  async function handleMarkDone() {
    if (!selectedPlan) return;
    const ok = await markPlanDone(sessionName, selectedPlan.name);
    if (ok) refreshPlans();
  }

  if (loading && !plans) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        Loading plans...
      </div>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        No plan files found in plans/
      </div>
    );
  }

  // Count by status
  const counts: Record<string, number> = {};
  for (const p of plans) counts[p.status] = (counts[p.status] ?? 0) + 1;

  return (
    <div className="flex-1 flex min-h-0">
      {/* Sidebar */}
      <div className="w-[260px] shrink-0 border-r border-[var(--border)] flex flex-col min-h-0">
        {/* Filter tabs */}
        <div className="flex items-center h-6 bg-[var(--surface)] border-b border-[var(--border)] text-[10px] shrink-0 px-1 gap-px">
          {(["all", "in-progress", "pending", "done"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-1.5 py-0.5 transition-colors ${
                statusFilter === s
                  ? "text-[var(--accent)]"
                  : "text-[var(--dim)] hover:text-[var(--fg)]"
              }`}
            >
              {s === "all" ? `all (${plans.length})` : `${s} (${counts[s] ?? 0})`}
            </button>
          ))}
        </div>

        {/* Plan list */}
        <div className="flex-1 overflow-y-auto">
          {filteredPlans.map((p) => {
            const isSelected = selectedFile === p.path;
            return (
              <button
                key={p.path}
                onClick={() => setSelectedFile(p.path)}
                className={`w-full text-left px-2 py-1 flex items-start gap-1.5 transition-colors ${
                  isSelected
                    ? "bg-[rgba(255,255,255,0.04)] text-[var(--accent)]"
                    : "text-[var(--fg)] hover:bg-[rgba(255,255,255,0.02)]"
                }`}
              >
                <span
                  className="shrink-0 mt-0.5 text-[11px]"
                  style={{ color: STATUS_COLORS[p.status] }}
                >
                  {STATUS_ICONS[p.status]}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12px]">{p.name}</span>
                  {p.completed && (
                    <span className="block text-[10px] text-[var(--dimmer)]">{p.completed}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col min-h-0">
        {loadingContent ? (
          <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
            loading...
          </div>
        ) : planData.content || editing ? (
          <>
            {/* Header */}
            <div className="shrink-0 border-b border-[var(--border)] px-3 flex items-center h-7">
              <div className="flex-1 flex items-center gap-2">
                {selectedPlan && (
                  <span
                    className="text-[11px]"
                    style={{ color: STATUS_COLORS[selectedPlan.status] }}
                  >
                    {STATUS_ICONS[selectedPlan.status]} {selectedPlan.status}
                  </span>
                )}
                <AuthorshipBar authorship={planData.authorship} />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {selectedPlan && selectedPlan.status !== "done" && !editing && (
                  <button
                    onClick={handleMarkDone}
                    className="text-[11px] px-2 py-0.5 text-[var(--green)] border border-[var(--border)] hover:border-[var(--green)] transition-colors"
                  >
                    mark done
                  </button>
                )}
                {editing && (
                  <>
                    <button
                      onClick={() => handleSave(editContent)}
                      disabled={saving}
                      className="text-[11px] px-2 py-0.5 text-[var(--bg)] bg-[var(--accent)] hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      {saving ? "saving..." : "save"}
                    </button>
                    <span className="text-[9px] text-[var(--dimmer)]">cmd+S</span>
                  </>
                )}
                <button
                  onClick={() =>
                    editing
                      ? setEditing(false)
                      : (() => {
                          setEditContent(planData.content);
                          setEditing(true);
                        })()
                  }
                  className={`text-[11px] px-2 py-0.5 border border-[var(--border)] transition-colors ${
                    editing
                      ? "text-[var(--accent)] border-[var(--accent)]"
                      : "text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--dim)]"
                  }`}
                >
                  {editing ? "view" : "edit"}
                </button>
              </div>
            </div>

            {/* Content */}
            {editing ? (
              <MarkdownEditor
                key={selectedFile}
                value={editContent}
                onChange={setEditContent}
                onSave={handleSave}
              />
            ) : (
              <div className="flex-1 overflow-y-auto p-4 max-w-3xl">
                {sections.map((section, i) => {
                  const ai = isAiAuthor(section.author);
                  const borderColor = section.author
                    ? ai
                      ? "var(--ai-color)"
                      : "var(--human-color)"
                    : "transparent";
                  const bgColor = section.author
                    ? ai
                      ? "var(--ai-bg)"
                      : "var(--human-bg)"
                    : "transparent";
                  const timeLabel = formatAuthorTime(section.authorAt);

                  return (
                    <div
                      key={`${section.heading}-${i}`}
                      className="plan-content"
                      style={{
                        borderLeft: section.author
                          ? `2px solid ${borderColor}`
                          : "2px solid transparent",
                        paddingLeft: "12px",
                        marginBottom: "4px",
                        background: bgColor,
                        borderRadius: "2px",
                      }}
                    >
                      {section.author && section.heading && (
                        <div className="flex items-center gap-2 mb-1 -mt-0.5">
                          <span
                            className="text-[9px] px-1 py-px rounded"
                            style={{
                              color: ai ? "var(--ai-color)" : "var(--human-color)",
                              background: ai ? "var(--ai-badge)" : "var(--human-badge)",
                            }}
                          >
                            {section.author}
                          </span>
                          {timeLabel && (
                            <span className="text-[9px] text-[var(--dimmer)]">{timeLabel}</span>
                          )}
                        </div>
                      )}
                      <Markdown>{section.content}</Markdown>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
            Select a plan to view
          </div>
        )}
      </div>
    </div>
  );
}
