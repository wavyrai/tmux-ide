"use client";

import { useState, useEffect, useRef } from "react";
import { createTask } from "@/lib/api";
import type { Goal } from "@/lib/types";

interface CreateTaskModalProps {
  sessionName: string;
  goals: Goal[];
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTaskModal({ sessionName, goals, onClose, onCreated }: CreateTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(2);
  const [goalId, setGoalId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setSaving(true);
    setError("");
    const ok = await createTask(sessionName, {
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      goal: goalId || undefined,
    });
    setSaving(false);
    if (ok) {
      onCreated();
      onClose();
    } else {
      setError("Failed to create task");
    }
  }

  const labelClass = "text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1";
  const inputClass =
    "w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] px-2 py-1 outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-[var(--modal-overlay)]" onClick={onClose} />
      <form
        onSubmit={handleSubmit}
        className="relative bg-[var(--bg)] border border-[var(--border)] w-full max-w-md"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-8 bg-[var(--surface)] border-b border-[var(--border)]">
          <span className="text-[var(--fg)]">new task</span>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
          >
            esc ×
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Title */}
          <div>
            <div className={labelClass}>title *</div>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              className={inputClass}
            />
          </div>

          {/* Description */}
          <div>
            <div className={labelClass}>description</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Details..."
              rows={3}
              className={`${inputClass} resize-none`}
            />
          </div>

          <div className="flex gap-3">
            {/* Priority */}
            <div className="flex-1">
              <div className={labelClass}>priority</div>
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className={inputClass}
              >
                <option value={1}>P1 — critical</option>
                <option value={2}>P2 — high</option>
                <option value={3}>P3 — normal</option>
                <option value={4}>P4 — low</option>
              </select>
            </div>

            {/* Goal */}
            <div className="flex-1">
              <div className={labelClass}>goal</div>
              <select
                value={goalId}
                onChange={(e) => setGoalId(e.target.value)}
                className={inputClass}
              >
                <option value="">none</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && <div className="text-[var(--red)] text-[11px]">{error}</div>}

          {/* Submit */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 text-[var(--dim)] border border-[var(--border)] hover:border-[var(--dim)] transition-colors"
            >
              cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1 text-[var(--bg)] bg-[var(--accent)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? "creating..." : "create"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
