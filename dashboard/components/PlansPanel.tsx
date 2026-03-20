"use client";

import { useState, useCallback, useEffect } from "react";
import Markdown from "react-markdown";
import { fetchPlans, fetchPlan, type PlanSummary } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

interface PlansPanelProps {
  sessionName: string;
}

export function PlansPanel({ sessionName }: PlansPanelProps) {
  const fetcher = useCallback(() => fetchPlans(sessionName), [sessionName]);
  const { data: plans, loading } = usePolling<PlanSummary[]>(fetcher, 10000);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loadingContent, setLoadingContent] = useState(false);

  useEffect(() => {
    if (!selectedFile) {
      setContent("");
      return;
    }
    setLoadingContent(true);
    fetchPlan(sessionName, selectedFile)
      .then((c) => setContent(c))
      .catch(() => setContent(""))
      .finally(() => setLoadingContent(false));
  }, [selectedFile, sessionName]);

  // Auto-select first plan
  useEffect(() => {
    if (!selectedFile && plans && plans.length > 0) {
      setSelectedFile(plans[0]!.path);
    }
  }, [plans, selectedFile]);

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
                  ? "bg-[rgba(255,255,255,0.04)] text-[var(--accent)]"
                  : "text-[var(--fg)] hover:bg-[rgba(255,255,255,0.02)]"
              }`}
            >
              {p.name}
            </button>
          );
        })}
      </div>

      {/* Markdown content */}
      <div className="flex-1 overflow-y-auto">
        {loadingContent ? (
          <div className="flex items-center justify-center h-full text-[var(--dim)]">
            loading…
          </div>
        ) : content ? (
          <div className="p-4 max-w-3xl plan-content">
            <Markdown>{content}</Markdown>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-[var(--dim)]">
            Select a plan to view
          </div>
        )}
      </div>
    </div>
  );
}
