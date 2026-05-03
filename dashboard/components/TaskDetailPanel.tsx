"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deleteTaskApi, injectIntoProject, updateTask, type EventData } from "@/lib/api";
import type { AgentDetail, Goal, Task } from "@/lib/types";
import { useToasts } from "@/lib/useToasts";
import { MarkdownEditor } from "./MarkdownEditor";

interface TaskDetailPanelProps {
  task: Task;
  sessionName: string;
  agents: AgentDetail[];
  goals: Goal[];
  events: EventData[];
  onClose: () => void;
  onUpdated: () => void;
}

const STATUS_COLORS: Record<Task["status"], string> = {
  "in-progress": "var(--yellow)",
  todo: "var(--dim)",
  review: "var(--magenta)",
  done: "var(--green)",
};

function statusLabel(status: Task["status"]): string {
  return status === "in-progress" ? "DOING" : status.toUpperCase();
}

function formatProof(proof: Task["proof"]): string {
  if (!proof) return "No proof recorded";
  if (proof.notes && Object.keys(proof).length === 1) return proof.notes;
  return JSON.stringify(proof, null, 2);
}

function eventText(event: EventData): string {
  if (event.message) return event.message;
  return `${event.type}${event.agent ? ` by ${event.agent}` : ""}`;
}

export function TaskDetailPanel({
  task,
  sessionName,
  agents,
  goals,
  events,
  onClose,
  onUpdated,
}: TaskDetailPanelProps) {
  const { push } = useToasts();
  const [closing, setClosing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState(task.priority);
  const [status, setStatus] = useState(task.status);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">(
    "idle",
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const baselineRef = useRef({
    title: task.title,
    description: task.description,
    priority: task.priority,
  });

  const taskEvents = useMemo(
    () =>
      events
        .filter((event) => event.taskId === task.id || event.message?.includes(task.id))
        .slice(0, 12),
    [events, task.id],
  );

  const goal = goals.find((row) => row.id === task.goal);
  const dirty =
    title !== baselineRef.current.title ||
    description !== baselineRef.current.description ||
    priority !== baselineRef.current.priority;

  useEffect(() => {
    baselineRef.current = {
      title: task.title,
      description: task.description,
      priority: task.priority,
    };
    setTitle(task.title);
    setDescription(task.description);
    setPriority(task.priority);
    setStatus(task.status);
    setSaveState("idle");
  }, [task.id, task.title, task.description, task.priority, task.status]);

  const requestClose = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  useEffect(() => {
    if (!dirty) return;
    setSaveState("dirty");
    const timer = setTimeout(() => {
      setSaveState("saving");
      updateTask(sessionName, task.id, {
        title: title.trim() || task.title,
        description,
        priority,
      })
        .then((updated) => {
          if (!updated) {
            setTitle(baselineRef.current.title);
            setDescription(baselineRef.current.description);
            setPriority(baselineRef.current.priority);
            setSaveState("error");
            push({
              kind: "error",
              title: "Failed to save task",
              body: task.id,
              scope: { project: sessionName },
            });
            return;
          }
          baselineRef.current = {
            title: updated.title,
            description: updated.description,
            priority: updated.priority,
          };
          setTitle(updated.title);
          setDescription(updated.description);
          setPriority(updated.priority);
          setSaveState("saved");
          onUpdated();
        })
        .catch(() => {
          setTitle(baselineRef.current.title);
          setDescription(baselineRef.current.description);
          setPriority(baselineRef.current.priority);
          setSaveState("error");
          push({
            kind: "error",
            title: "Failed to save task",
            body: task.id,
            scope: { project: sessionName },
          });
        });
    }, 800);
    return () => clearTimeout(timer);
  }, [description, dirty, onUpdated, priority, push, sessionName, task.id, task.title, title]);

  async function markDone() {
    const updated = await updateTask(sessionName, task.id, { status: "done" });
    if (!updated) {
      push({ kind: "error", title: "Failed to mark task done", body: task.id });
      return;
    }
    setStatus("done");
    onUpdated();
  }

  async function sendToAgent() {
    const ok = await injectIntoProject(
      sessionName,
      `Task ${task.id}: ${title}\n\n${description}`.trim(),
      { sendEnter: true },
    );
    push({
      kind: ok ? "success" : "error",
      title: ok ? "Sent task to active agent" : "Failed to send task",
      body: task.id,
      scope: { project: sessionName },
    });
  }

  function redispatch() {
    push({
      kind: "info",
      title: "Re-dispatch coming soon",
      body: task.id,
      scope: { project: sessionName },
      durationMs: 1800,
    });
  }

  async function deleteTask() {
    const ok = await deleteTaskApi(sessionName, task.id);
    if (!ok) {
      push({ kind: "error", title: "Failed to delete task", body: task.id });
      return;
    }
    onUpdated();
    requestClose();
  }

  const saveText =
    saveState === "dirty"
      ? "unsaved"
      : saveState === "saving"
        ? "saving..."
        : saveState === "saved"
          ? "saved"
          : saveState === "error"
            ? "save failed"
            : "";

  return (
    <div data-testid="task-detail-panel" className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close task panel"
        onClick={requestClose}
        className={`absolute inset-0 bg-[var(--modal-overlay)] transition-opacity duration-200 motion-reduce:transition-none ${
          closing ? "opacity-0" : "opacity-100"
        }`}
      />
      <aside
        className={`absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col border-l border-[var(--border)] bg-[var(--bg)] shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none ${
          closing ? "translate-x-full" : "translate-x-0"
        }`}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-2">
              <span
                data-testid="task-panel-status"
                className="rounded-sm border border-[var(--border)] px-1.5 py-0.5 text-[10px]"
                style={{ color: STATUS_COLORS[status] }}
              >
                {statusLabel(status)}
              </span>
              <span className="text-[11px] text-[var(--dim)]">task {task.id}</span>
              {saveText && <span className="text-[10px] text-[var(--dimmer)]">{saveText}</span>}
            </div>
            <input
              data-testid="task-panel-edit-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full bg-transparent text-[18px] font-semibold text-[var(--fg)] outline-none placeholder:text-[var(--dimmer)]"
              placeholder="Task title"
            />
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="text-[20px] leading-none text-[var(--dim)] transition-colors hover:text-[var(--fg)]"
            aria-label="Close"
          >
            x
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <section>
            <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-[var(--dimmer)]">
              description
            </div>
            <div className="min-h-52 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-strong)]">
              <MarkdownEditor
                key={task.id}
                value={description || ""}
                onChange={setDescription}
                onSave={setDescription}
              />
            </div>
          </section>

          <section className="mt-5 grid grid-cols-2 gap-3 text-[11px]">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--dimmer)]">
                assignee
              </div>
              <div className="rounded-sm border border-[var(--border)] px-2 py-1 text-[var(--fg-secondary)]">
                {task.assignee || "unassigned"}
              </div>
            </div>
            <label>
              <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--dimmer)]">
                priority
              </div>
              <input
                type="number"
                min={1}
                max={5}
                value={priority}
                onChange={(event) => setPriority(Number(event.target.value))}
                className="h-7 w-full rounded-sm border border-[var(--border)] bg-[var(--surface)] px-2 text-[var(--fg)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--dimmer)]">
                goal
              </div>
              <div className="rounded-sm border border-[var(--border)] px-2 py-1 text-[var(--fg-secondary)]">
                {goal?.title || task.goal || "none"}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--dimmer)]">
                milestone
              </div>
              <div className="rounded-sm border border-[var(--border)] px-2 py-1 text-[var(--magenta)]">
                {task.milestone || "none"}
              </div>
            </div>
          </section>

          {task.tags.length > 0 && (
            <section className="mt-4 flex flex-wrap gap-1">
              {task.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-sm border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--fg-secondary)]"
                >
                  #{tag}
                </span>
              ))}
            </section>
          )}

          <section className="mt-5">
            <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-[var(--dimmer)]">
              proof
            </div>
            <pre className="max-h-48 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--fg-secondary)]">
              {formatProof(task.proof)}
            </pre>
          </section>

          <section className="mt-5">
            <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-[var(--dimmer)]">
              dispatch history
            </div>
            <div className="space-y-2">
              {taskEvents.length === 0 ? (
                <div className="text-[11px] text-[var(--dim)]">No events for this task</div>
              ) : (
                taskEvents.map((event) => (
                  <div
                    key={`${event.timestamp}:${event.type}:${event.message}`}
                    className="grid grid-cols-[auto_1fr] gap-2 text-[11px]"
                  >
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                    <div>
                      <div className="text-[var(--fg-secondary)]">{eventText(event)}</div>
                      <div className="text-[var(--dimmer)]">{event.relative}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section data-testid="task-panel-actions" className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void markDone()}
              className="rounded-sm border border-[var(--green)] px-2 py-1 text-[11px] text-[var(--green)] transition-colors hover:bg-[var(--surface-hover)]"
            >
              Mark done
            </button>
            <button
              type="button"
              onClick={redispatch}
              className="rounded-sm border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Re-dispatch
            </button>
            <button
              type="button"
              onClick={() => void sendToAgent()}
              className="rounded-sm border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Send to active agent
            </button>
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  onClick={() => void deleteTask()}
                  className="rounded-sm border border-[var(--red)] bg-[var(--red)] px-2 py-1 text-[11px] text-[var(--bg)]"
                >
                  Confirm delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-sm border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--dim)]"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-sm border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--red)] transition-colors hover:border-[var(--red)]"
              >
                Delete
              </button>
            )}
          </section>

          {agents.length > 0 && (
            <section className="mt-5">
              <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-[var(--dimmer)]">
                agents
              </div>
              <div className="flex flex-wrap gap-1">
                {agents.map((agent) => (
                  <span
                    key={agent.paneId}
                    className="rounded-sm border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-secondary)]"
                  >
                    {agent.paneTitle}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
