"use client";

import { useState } from "react";
import { updateTask } from "@/lib/api";
import type { Task, AgentDetail } from "@/lib/types";

interface TaskDetailProps {
  task: Task;
  sessionName: string;
  agents: AgentDetail[];
  onClose: () => void;
  onUpdated: () => void;
}

const STATUSES: Task["status"][] = ["todo", "in-progress", "review", "done"];

const STATUS_COLORS: Record<Task["status"], string> = {
  "in-progress": "var(--yellow)",
  todo: "var(--dim)",
  review: "var(--magenta)",
  done: "var(--green)",
};

const STATUS_LABELS: Record<Task["status"], string> = {
  "in-progress": "DOING",
  todo: "TODO",
  review: "REVIEW",
  done: "DONE",
};

export function TaskDetail({
  task: t,
  sessionName,
  agents,
  onClose,
  onUpdated,
}: TaskDetailProps) {
  const [saving, setSaving] = useState(false);

  async function changeStatus(status: string) {
    setSaving(true);
    await updateTask(sessionName, t.id, { status });
    onUpdated();
    setSaving(false);
  }

  async function changeAssignee(assignee: string) {
    setSaving(true);
    await updateTask(sessionName, t.id, { assignee: assignee || undefined });
    onUpdated();
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-[var(--bg)] border-l border-[var(--border)] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-8 bg-[var(--surface)] border-b border-[var(--border)]">
          <span className="text-[var(--dim)]">task {t.id}</span>
          <button
            onClick={onClose}
            className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
          >
            esc ×
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Title */}
          <div>
            <div className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
              title
            </div>
            <div className="text-[var(--fg)]">{t.title}</div>
          </div>

          {/* Description */}
          {t.description && (
            <div>
              <div className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
                description
              </div>
              <div className="text-[var(--fg)] whitespace-pre-wrap">
                {t.description}
              </div>
            </div>
          )}

          {/* Status */}
          <div>
            <div className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
              status
            </div>
            <div className="flex gap-1">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  disabled={saving}
                  onClick={() => changeStatus(s)}
                  className={`px-2 py-0.5 border transition-colors ${
                    t.status === s
                      ? "border-[var(--accent)] bg-[rgba(255,255,255,0.04)]"
                      : "border-[var(--border)] hover:border-[rgba(255,255,255,0.15)]"
                  }`}
                  style={t.status === s ? { color: STATUS_COLORS[s] } : { color: "var(--dim)" }}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Priority */}
          <div>
            <div className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
              priority
            </div>
            <span
              style={{
                color:
                  t.priority === 1
                    ? "var(--red)"
                    : t.priority === 2
                      ? "var(--yellow)"
                      : "var(--accent)",
              }}
            >
              {"*".repeat(Math.max(1, 4 - t.priority))} P{t.priority}
            </span>
          </div>

          {/* Assignee */}
          <div>
            <div className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
              assignee
            </div>
            <select
              value={t.assignee ?? ""}
              onChange={(e) => changeAssignee(e.target.value)}
              disabled={saving}
              className="bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] px-2 py-1 w-full outline-none focus:border-[var(--accent)]"
            >
              <option value="">unassigned</option>
              {agents.map((a) => (
                <option key={a.paneTitle} value={a.paneTitle}>
                  {a.paneTitle}
                </option>
              ))}
            </select>
          </div>

          {/* Branch */}
          {t.branch && (
            <div>
              <div className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
                branch
              </div>
              <div className="text-[var(--cyan)]">⎇ {t.branch}</div>
            </div>
          )}

          {/* Tags */}
          {t.tags.length > 0 && (
            <div>
              <div className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
                tags
              </div>
              <div className="flex gap-1 flex-wrap">
                {t.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 bg-[rgba(255,255,255,0.04)] border border-[var(--border)] text-[var(--dim)] text-[11px]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
