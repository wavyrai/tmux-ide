"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Markdown from "react-markdown";
import {
  fetchPlans,
  fetchPlan,
  type PlanSummary,
  type PlanData,
  type AuthorshipData,
} from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { AuthorshipBar } from "./AuthorshipBar";

interface PlansPanelProps {
  sessionName: string;
}

interface MarkdownSection {
  heading: string;
  content: string;
  author: string | null;
  authorAt: string | null;
}

function splitIntoSections(
  markdown: string,
  authorship: AuthorshipData | null,
): MarkdownSection[] {
  // Split on ## headings, keeping the heading with its content
  const lines = markdown.split("\n");
  const sections: MarkdownSection[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      // Save previous section
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

  // Last section
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
  return author.startsWith("ai") || author.toLowerCase().includes("claude") || author.toLowerCase().includes("agent");
}

function formatAuthorTime(at: string | null): string {
  if (!at) return "";
  try {
    const d = new Date(at);
    const now = Date.now();
    const ms = now - d.getTime();
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  } catch {
    return "";
  }
}

export function PlansPanel({ sessionName }: PlansPanelProps) {
  const fetcher = useCallback(() => fetchPlans(sessionName), [sessionName]);
  const { data: plans, loading } = usePolling<PlanSummary[]>(fetcher, 10000);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [planData, setPlanData] = useState<PlanData>({ content: "", authorship: null });
  const [loadingContent, setLoadingContent] = useState(false);

  useEffect(() => {
    if (!selectedFile) {
      setPlanData({ content: "", authorship: null });
      return;
    }
    setLoadingContent(true);
    fetchPlan(sessionName, selectedFile)
      .then((d) => setPlanData(d))
      .catch(() => setPlanData({ content: "", authorship: null }))
      .finally(() => setLoadingContent(false));
  }, [selectedFile, sessionName]);

  useEffect(() => {
    if (!selectedFile && plans && plans.length > 0) {
      setSelectedFile(plans[0]!.path);
    }
  }, [plans, selectedFile]);

  const sections = useMemo(
    () => splitIntoSections(planData.content, planData.authorship),
    [planData],
  );

  if (loading && !plans) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        Loading plans…
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

  return (
    <div className="flex-1 flex min-h-0">
      {/* File sidebar */}
      <div className="w-[240px] shrink-0 border-r border-[var(--border)] overflow-y-auto">
        <div className="h-6 flex items-center px-3 bg-[var(--surface)] border-b border-[var(--border)] text-[10px] text-[var(--dim)] uppercase tracking-wider">
          Plans ({plans.length})
        </div>
        {plans.map((p) => {
          const isSelected = selectedFile === p.path;
          return (
            <button
              key={p.path}
              onClick={() => setSelectedFile(p.path)}
              className={`w-full text-left h-6 px-3 flex items-center transition-colors truncate ${
                isSelected
                  ? "bg-[var(--surface-active)] text-[var(--accent)]"
                  : "text-[var(--fg)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              {p.name}
            </button>
          );
        })}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {loadingContent ? (
          <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
            loading…
          </div>
        ) : planData.content ? (
          <>
            {/* Authorship bar */}
            <div className="shrink-0 border-b border-[var(--border)] px-3">
              <AuthorshipBar authorship={planData.authorship} />
            </div>

            {/* Rendered sections */}
            <div className="p-4 max-w-3xl">
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
                    {/* Author badge */}
                    {section.author && section.heading && (
                      <div className="flex items-center gap-2 mb-1 -mt-0.5">
                        <span
                          className="text-[9px] px-1 py-px rounded"
                          style={{
                            color: ai ? "var(--ai-color)" : "var(--human-color)",
                            background: ai
                              ? "rgba(165,180,252,0.15)"
                              : "rgba(110,231,183,0.15)",
                          }}
                        >
                          {section.author}
                        </span>
                        {timeLabel && (
                          <span className="text-[9px] text-[var(--dimmer)]">
                            {timeLabel}
                          </span>
                        )}
                      </div>
                    )}
                    <Markdown>{section.content}</Markdown>
                  </div>
                );
              })}
            </div>
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
