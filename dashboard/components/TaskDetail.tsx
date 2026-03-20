"use client";

import { useState } from "react";
import { updateTask, deleteTaskApi } from "@/lib/api";
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
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(t.title);
  const [editDesc, setEditDesc] = useState(t.description);
  const [editPriority, setEditPriority] = useState(t.priority);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  async function handleSaveEdit() {
    setSaving(true);
    // Use the existing POST endpoint which accepts partial updates
    await fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5050"}/api/project/${encodeURIComponent(sessionName)}/task/${encodeURIComponent(t.id)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDesc.trim(),
          priority: editPriority,
        }),
      },
    );
    onUpdated();
    setSaving(false);
    setEditing(false);
  }

  async function handleDelete() {
    setSaving(true);
    await deleteTaskApi(sessionName, t.id);
    onUpdated();
    onClose();
  }

  const labelClass = "text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1";
  const inputClass =
    "w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] px-2 py-1 outline-none focus:border-[var(--accent)]";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[var(--bg)] border-l border-[var(--border)] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-8 bg-[var(--surface)] border-b border-[var(--border)]">
          <span className="text-[var(--dim)]">task {t.id}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditing(!editing)}
              className={`text-[11px] transition-colors ${editing ? "text-[var(--accent)]" : "text-[var(--dim)] hover:text-[var(--fg)]"}`}
            >
              {editing ? "viewing" : "edit"}
            </button>
            <button
              onClick={onClose}
              className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
            >
              ×
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* Title */}
          <div>
            <div className={labelClass}>title</div>
            {editing ? (
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className={inputClass}
              />
            ) : (
              <div className="text-[var(--fg)]">{t.title}</div>
            )}
          </div>

          {/* Description */}
          <div>
            <div className={labelClass}>description</div>
            {editing ? (
              <textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={3}
                className={`${inputClass} resize-none`}
              />
            ) : (
              <div className="text-[var(--fg)] whitespace-pre-wrap">
                {t.description || <span className="text-[var(--dim)]">—</span>}
              </div>
            )}
          </div>

          {/* Priority (editable) */}
          <div>
            <div className={labelClass}>priority</div>
            {editing ? (
              <select
                value={editPriority}
                onChange={(e) => setEditPriority(Number(e.target.value))}
                className={inputClass}
              >
                <option value={1}>P1 — critical</option>
                <option value={2}>P2 — high</option>
                <option value={3}>P3 — normal</option>
                <option value={4}>P4 — low</option>
              </select>
            ) : (
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
            )}
          </div>

          {/* Save edit button */}
          {editing && (
            <button
              onClick={handleSaveEdit}
              disabled={saving}
              className="px-3 py-1 text-[var(--bg)] bg-[var(--accent)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? "saving..." : "save"}
            </button>
          )}

          {/* Status */}
          {!editing && (
            <div>
              <div className={labelClass}>status</div>
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
          )}

          {/* Assignee */}
          {!editing && (
            <div>
              <div className={labelClass}>assignee</div>
              <select
                value={t.assignee ?? ""}
                onChange={(e) => changeAssignee(e.target.value)}
                disabled={saving}
                className={inputClass}
              >
                <option value="">unassigned</option>
                {agents.map((a, i) => (
                  <option key={`${a.paneTitle}-${i}`} value={a.paneTitle}>
                    {a.paneTitle}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Branch */}
          {t.branch && (
            <div>
              <div className={labelClass}>branch</div>
              <div className="text-[var(--cyan)]">⎇ {t.branch}</div>
            </div>
          )}

          {/* Tags */}
          {t.tags.length > 0 && (
            <div>
              <div className={labelClass}>tags</div>
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

          {/* Delete */}
          <div className="pt-4 border-t border-[var(--border)]">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-[var(--red)] text-[11px]">Delete task {t.id}?</span>
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="px-2 py-0.5 text-[var(--bg)] bg-[var(--red)] text-[11px] hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? "deleting..." : "confirm"}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-0.5 text-[var(--dim)] border border-[var(--border)] text-[11px] hover:text-[var(--fg)]"
                >
                  cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-[var(--red)] text-[11px] hover:underline"
              >
                delete task
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
