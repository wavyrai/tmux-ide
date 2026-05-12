"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import { VSeparator, HSeparator } from "./Separators";
import {
  fetchPlan,
  fetchPlans,
  markPlanDone,
  savePlan,
  type PlanData,
  type PlanStatus,
  type PlanSummary,
} from "@/lib/api";
import { Badge, Card, RowSpaceBetween } from "@/components/v2-primitives";
import { usePolling } from "@/lib/usePolling";
import { useToasts } from "@/lib/useToasts";
import { AuthorshipBar } from "@/components/AuthorshipBar";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { PlansPanelBridge } from "@/components/plans-panel-bridge";
import type { Task } from "@/lib/types";

interface V2PlansViewProps {
  sessionName: string;
  tasks: Task[];
}

const STATUS_GLYPH: Record<string, string> = {
  todo: "○",
  "in-progress": "◐",
  review: "◑",
  done: "●",
};

const PLAN_STATUSES: ReadonlyArray<PlanStatus | "all"> = ["all", "in-progress", "pending", "done"];

const PROGRESS_CELLS = 16;

function progressBar(filled: number): string {
  const safe = Math.max(0, Math.min(PROGRESS_CELLS, Math.round(filled)));
  return "▒".repeat(safe) + "░".repeat(PROGRESS_CELLS - safe);
}

function tasksLinkedToPlan(tasks: Task[], plan: PlanSummary | null): Task[] {
  if (!plan) return [];
  const needle = plan.name.toLowerCase();
  return tasks.filter((t) => t.description?.toLowerCase().includes(needle));
}

function timeAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const ms = Date.now() - t;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function V2PlansView({ sessionName, tasks }: V2PlansViewProps) {
  const fetcher = useCallback(() => fetchPlans(sessionName), [sessionName]);
  const { data: plans, refresh: refreshPlans } = usePolling<PlanSummary[]>(fetcher, 10000);
  const { push } = useToasts();

  const [statusFilter, setStatusFilter] = useState<PlanStatus | "all">("all");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [planData, setPlanData] = useState<PlanData>({ content: "", authorship: null });
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
    if (!selectedFile && filteredPlans.length > 0) {
      setSelectedFile(filteredPlans[0]!.path);
    }
  }, [filteredPlans, selectedFile]);

  useEffect(() => {
    if (!selectedFile) {
      setPlanData({ content: "", authorship: null });
      setEditing(false);
      return;
    }
    setEditing(false);
    fetchPlan(sessionName, selectedFile)
      .then((d) => {
        setPlanData(d);
        setEditContent(d.content);
      })
      .catch(() => setPlanData({ content: "", authorship: null }));
  }, [selectedFile, sessionName]);

  const linkedTasks = useMemo(() => tasksLinkedToPlan(tasks, selectedPlan), [tasks, selectedPlan]);
  const doneCount = linkedTasks.filter((t) => t.status === "done").length;
  const pct = linkedTasks.length > 0 ? doneCount / linkedTasks.length : 0;
  const filled = Math.round(pct * PROGRESS_CELLS);

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

  function handleConvert() {
    push({
      kind: "info",
      title: "Plan→Mission converter coming soon",
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--fg)]">
        <header
          data-testid="v2-plans-header"
          className="flex h-7 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 text-[11px] tabular-nums"
        >
          <span className="font-medium text-[var(--fg)] truncate">
            {selectedPlan?.title || selectedPlan?.name || "Plans"}
          </span>
          {selectedPlan && <Badge>{selectedPlan.status}</Badge>}
          <span
            aria-hidden="true"
            className="font-mono text-[var(--accent)]"
            title={`${doneCount}/${linkedTasks.length} linked tasks done`}
          >
            {progressBar(filled)}
          </span>
          <span className="text-[10px] text-[var(--dim)]">
            {linkedTasks.length === 0 ? "no linked tasks" : `${doneCount}/${linkedTasks.length}`}
          </span>
          <span className="flex-1" />
          {selectedPlan && (
            <>
              <button
                type="button"
                data-testid="v2-plans-edit"
                onClick={() => {
                  if (editing) {
                    setEditing(false);
                  } else {
                    setEditContent(planData.content);
                    setEditing(true);
                  }
                }}
                className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
              >
                {editing ? "[cancel]" : "[edit]"}
              </button>
              {selectedPlan.status !== "done" && (
                <button
                  type="button"
                  data-testid="v2-plans-done"
                  onClick={() => void handleMarkDone()}
                  className="text-[var(--green)] hover:text-[var(--fg)] transition-colors"
                >
                  [done]
                </button>
              )}
              <button
                type="button"
                data-testid="v2-plans-convert"
                onClick={handleConvert}
                className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
              >
                [convert]
              </button>
            </>
          )}
        </header>

        <div className="flex-1 min-h-0">
          <Group orientation="horizontal">
            {/* LEFT RAIL */}
            <Panel id="plans-rail-left" defaultSize={20} minSize={14}>
              <div className="flex h-full flex-col overflow-hidden">
                <div className="flex h-7 shrink-0 items-center gap-px border-b border-[var(--border)] bg-[var(--surface)] px-1 text-[10px]">
                  {PLAN_STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      data-testid={`v2-plans-filter-${s}`}
                      onClick={() => setStatusFilter(s)}
                      className={
                        statusFilter === s
                          ? "px-1.5 py-0.5 text-[var(--accent)]"
                          : "px-1.5 py-0.5 text-[var(--dim)] hover:text-[var(--fg)]"
                      }
                    >
                      {s === "all" ? `all (${plans?.length ?? 0})` : s}
                    </button>
                  ))}
                </div>
                <ul className="m-0 list-none flex-1 overflow-y-auto p-0">
                  {filteredPlans.map((p) => {
                    const sel = selectedFile === p.path;
                    return (
                      <li key={p.path}>
                        <button
                          type="button"
                          data-testid={`v2-plans-item-${p.name}`}
                          onClick={() => setSelectedFile(p.path)}
                          className={
                            sel
                              ? "flex w-full items-center gap-1.5 border-l-2 border-[var(--accent)] bg-[var(--surface-hover)] px-2 py-1 text-left text-[12px] text-[var(--accent)]"
                              : "flex w-full items-center gap-1.5 border-l-2 border-transparent px-2 py-1 text-left text-[12px] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                          }
                        >
                          <span
                            aria-hidden="true"
                            className="font-mono text-[10px] text-[var(--dim)]"
                          >
                            {p.status === "done" ? "✓" : p.status === "in-progress" ? "●" : "○"}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{p.title || p.name}</span>
                        </button>
                      </li>
                    );
                  })}
                  {filteredPlans.length === 0 && (
                    <li className="px-2 py-2 text-[11px] text-[var(--dim)]">— no plans —</li>
                  )}
                </ul>
              </div>
            </Panel>

            <VSeparator />

            {/* CENTER */}
            <Panel id="plans-center" defaultSize={56} minSize={30}>
              <div className="flex h-full flex-col overflow-hidden">
                {editing ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-[11px]">
                      <span className="text-[var(--dim)]">editing</span>
                      <span className="flex-1" />
                      <button
                        type="button"
                        data-testid="v2-plans-save"
                        disabled={saving}
                        onClick={() => void handleSave(editContent)}
                        className="text-[var(--accent)] hover:text-[var(--fg)] disabled:opacity-50"
                      >
                        {saving ? "[saving…]" : "[save ⌘S]"}
                      </button>
                    </div>
                    <MarkdownEditor
                      key={selectedFile}
                      value={editContent}
                      onChange={setEditContent}
                      onSave={handleSave}
                    />
                  </div>
                ) : selectedPlan ? (
                  <div
                    data-testid="v2-plans-markdown"
                    className="flex h-full min-h-0 flex-col overflow-hidden"
                  >
                    <PlansPanelBridge plan={selectedPlan} planData={planData} />
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-[var(--dim)]">
                    select a plan to view
                  </div>
                )}
              </div>
            </Panel>

            <VSeparator />

            {/* RIGHT RAIL */}
            <Panel id="plans-rail-right" defaultSize={24} minSize={14}>
              <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
                <Card title="LINKED TASKS" mode="left">
                  {linkedTasks.length === 0 ? (
                    <p className="text-[var(--dim)]">— no linked tasks —</p>
                  ) : (
                    linkedTasks.slice(0, 16).map((t) => (
                      <RowSpaceBetween key={t.id}>
                        <span className="truncate">
                          <span aria-hidden="true" className="mr-1 font-mono">
                            {STATUS_GLYPH[t.status] ?? "·"}
                          </span>
                          {t.title}
                        </span>
                        <span className="text-[var(--dim)] tabular-nums">{t.id}</span>
                      </RowSpaceBetween>
                    ))
                  )}
                </Card>

                <Card title="AUTHORSHIP" mode="left">
                  <AuthorshipBar authorship={planData.authorship} />
                </Card>

                <Card title="HISTORY" mode="left">
                  <PlanHistory plan={selectedPlan} />
                </Card>
              </div>
            </Panel>
          </Group>
        </div>
      </div>
  );
}

function PlanHistory({ plan }: { plan: PlanSummary | null }) {
  if (!plan) {
    return <p className="text-[var(--dim)]">— no history —</p>;
  }
  const updated = timeAgo(plan.updated ?? null);
  const completed = timeAgo(plan.completed ?? null);
  const owner = plan.owner ?? null;
  return (
    <ul className="m-0 list-none p-0 text-[11px] text-[var(--dim)]">
      {completed && (
        <li>
          <span className="text-[var(--green)]">{completed}</span>
          {owner ? <> · {owner}</> : null} done
        </li>
      )}
      {updated && (
        <li>
          <span className="text-[var(--accent)]">{updated}</span>
          {owner ? <> · {owner}</> : null} updated
        </li>
      )}
      {!completed && !updated && <li>{plan.status === "done" ? "completed" : "in progress"}</li>}
    </ul>
  );
}
