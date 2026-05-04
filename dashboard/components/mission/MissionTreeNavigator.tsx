"use client";

import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Flag,
  Search,
  Target,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useDeferredValue, useMemo, useState } from "react";
import { Button, StatusPill } from "@/components/ui";
import { milestoneVariant } from "./utils";
import { useSessionStream } from "@/lib/useSessionStream";
import type { Goal, Task } from "@/lib/types";
import type { MilestoneData } from "@/lib/api";
import { NavigatorShell } from "@/components/navigators/NavigatorShell";

interface MissionTreeNavigatorProps {
  sessionName: string;
  onTaskClick?: (task: Task) => void;
}

interface GoalGroup {
  goal: Goal;
  tasks: Task[];
}

interface MilestoneGroup {
  milestone: MilestoneData | null;
  goals: GoalGroup[];
  unassignedTasks: Task[];
}

const STATUS_COLOR: Record<string, string> = {
  locked: "var(--dim)",
  active: "var(--accent)",
  validating: "var(--yellow)",
  done: "var(--green)",
  todo: "var(--dim)",
  "in-progress": "var(--accent)",
  review: "var(--yellow)",
};

function colorFor(status: string | undefined | null): string {
  if (!status) return "var(--dim)";
  return STATUS_COLOR[status] ?? "var(--dim)";
}

function matchesQuery(text: string | null | undefined, q: string): boolean {
  if (!q) return true;
  if (!text) return false;
  return text.toLowerCase().includes(q);
}

/**
 * Tree of mission → milestones → goals → tasks for the active project.
 * Linear-grade rebuild with motion expand, status pills, search filter,
 * and click-to-open task callbacks.
 */
export function MissionTreeNavigator({ sessionName, onTaskClick }: MissionTreeNavigatorProps) {
  const { snapshot } = useSessionStream(sessionName);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const groups: MilestoneGroup[] = useMemo(() => {
    const project = snapshot?.project;
    if (!project) return [];

    const milestones = snapshot?.milestones ?? [];
    const goals = project.goals;
    const tasks = project.tasks;

    const taskByGoal = new Map<string, Task[]>();
    const goalByMilestone = new Map<string, Goal[]>();
    const orphanGoals: Goal[] = [];
    const orphanTasks: Task[] = [];

    for (const task of tasks) {
      if (task.goal) {
        const list = taskByGoal.get(task.goal) ?? [];
        list.push(task);
        taskByGoal.set(task.goal, list);
      } else {
        orphanTasks.push(task);
      }
    }

    for (const goal of goals) {
      const milestoneId = goal.milestone;
      if (milestoneId) {
        const list = goalByMilestone.get(milestoneId) ?? [];
        list.push(goal);
        goalByMilestone.set(milestoneId, list);
      } else {
        orphanGoals.push(goal);
      }
    }

    const result: MilestoneGroup[] = [];
    for (const milestone of milestones) {
      const milestoneGoals = goalByMilestone.get(milestone.id) ?? [];
      result.push({
        milestone,
        goals: milestoneGoals.map((goal) => ({
          goal,
          tasks: taskByGoal.get(goal.id) ?? [],
        })),
        unassignedTasks: [],
      });
    }

    if (orphanGoals.length > 0 || orphanTasks.length > 0) {
      result.push({
        milestone: null,
        goals: orphanGoals.map((goal) => ({
          goal,
          tasks: taskByGoal.get(goal.id) ?? [],
        })),
        unassignedTasks: orphanTasks,
      });
    }

    return result;
  }, [snapshot]);

  const filtered: MilestoneGroup[] = useMemo(() => {
    if (!deferredQuery) return groups;
    const q = deferredQuery;
    const out: MilestoneGroup[] = [];
    for (const group of groups) {
      const milestoneMatch = matchesQuery(group.milestone?.title, q);
      const filteredGoals = group.goals
        .map((g) => ({
          goal: g.goal,
          tasks: g.tasks.filter(
            (t) => matchesQuery(t.title, q) || matchesQuery(t.id, q),
          ),
        }))
        .filter(
          (g) =>
            milestoneMatch ||
            matchesQuery(g.goal.title, q) ||
            g.tasks.length > 0,
        );
      const filteredOrphans = group.unassignedTasks.filter(
        (t) => matchesQuery(t.title, q) || matchesQuery(t.id, q),
      );
      if (
        milestoneMatch ||
        filteredGoals.length > 0 ||
        filteredOrphans.length > 0
      ) {
        out.push({
          milestone: group.milestone,
          goals: filteredGoals,
          unassignedTasks: filteredOrphans,
        });
      }
    }
    return out;
  }, [groups, deferredQuery]);

  function toggle(key: string) {
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  }

  const mission = snapshot?.mission?.mission;
  const missionStatus = mission?.status ?? "planning";

  return (
    <NavigatorShell
      title="Mission"
      subtitle={mission?.title}
      testId="mission-tree-navigator"
    >
      {!snapshot?.project ? (
        <div className="px-3 py-3 text-[11px] text-[var(--dim)]">loading project...</div>
      ) : (
        <>
          <div className="border-b border-[var(--border-weak)] px-3 py-2">
            <div className="flex items-center gap-2">
              <Flag
                aria-hidden="true"
                size={13}
                strokeWidth={1.6}
                className="shrink-0 text-[var(--accent)]"
              />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--fg)]">
                {mission?.title ?? "no mission"}
              </span>
              <span
                className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px]"
                style={{
                  background: "var(--surface)",
                  color: colorFor(missionStatus),
                }}
              >
                {missionStatus}
              </span>
            </div>
          </div>

          <div className="border-b border-[var(--border-weak)] px-2 py-2">
            <div className="flex items-center gap-2 rounded-md border border-[var(--border-weak)] bg-[var(--bg)] px-2 py-1 focus-within:border-[var(--accent)]">
              <Search aria-hidden="true" size={11} className="text-[var(--dim)]" />
              <input
                data-testid="mission-tree-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search mission tree"
                className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--fg)] outline-none placeholder:text-[var(--dim)]"
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setQuery("")}
                  data-testid="mission-tree-search-clear"
                  aria-label="Clear search"
                >
                  <X aria-hidden="true" size={11} />
                </Button>
              )}
            </div>
          </div>

          <ul className="m-0 list-none p-0">
            {filtered.map((group, index) => {
              const milestoneId = group.milestone?.id ?? `__orphan-${index}`;
              const milestoneCollapsed = Boolean(collapsed[`m:${milestoneId}`]);
              return (
                <li key={milestoneId}>
                  <button
                    type="button"
                    data-testid={`navigator-milestone-${milestoneId}`}
                    onClick={() => toggle(`m:${milestoneId}`)}
                    aria-expanded={!milestoneCollapsed}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover-only:hover:bg-[var(--surface-hover)] focus-visible:focus-ring"
                  >
                    {milestoneCollapsed ? (
                      <ChevronRight aria-hidden="true" size={12} className="shrink-0" />
                    ) : (
                      <ChevronDown aria-hidden="true" size={12} className="shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--fg)]">
                      {group.milestone ? group.milestone.title : "Unassigned"}
                    </span>
                    {group.milestone && (
                      <>
                        <StatusPill
                          variant={milestoneVariant(group.milestone.status)}
                          label={group.milestone.status}
                          dot={false}
                        />
                        <span className="shrink-0 text-[10px] tabular-nums text-[var(--dim)]">
                          {group.milestone.tasksDone}/{group.milestone.taskCount}
                        </span>
                      </>
                    )}
                  </button>

                  <AnimatePresence initial={false}>
                    {!milestoneCollapsed && (
                      <motion.ul
                        key="goals"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ type: "spring", stiffness: 600, damping: 49 }}
                        className="m-0 list-none overflow-hidden p-0"
                      >
                        {group.goals.map(({ goal, tasks }, i) => {
                          const goalCollapsed = Boolean(collapsed[`g:${goal.id}`]);
                          return (
                            <motion.li
                              key={goal.id}
                              initial={{ opacity: 0, x: -4 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{
                                type: "spring",
                                stiffness: 600,
                                damping: 49,
                                delay: i * 0.02,
                              }}
                            >
                              <button
                                type="button"
                                data-testid={`navigator-goal-${goal.id}`}
                                onClick={() => toggle(`g:${goal.id}`)}
                                aria-expanded={!goalCollapsed}
                                className="flex w-full items-center gap-2 py-1.5 pl-7 pr-3 text-left transition-colors hover-only:hover:bg-[var(--surface-hover)] focus-visible:focus-ring"
                              >
                                {goalCollapsed ? (
                                  <ChevronRight aria-hidden="true" size={11} className="shrink-0" />
                                ) : (
                                  <ChevronDown aria-hidden="true" size={11} className="shrink-0" />
                                )}
                                <Target
                                  aria-hidden="true"
                                  size={11}
                                  strokeWidth={1.6}
                                  className="shrink-0"
                                  style={{ color: colorFor(goal.status) }}
                                />
                                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--fg-secondary)]">
                                  {goal.title}
                                </span>
                                <span className="shrink-0 text-[10px] tabular-nums text-[var(--dim)]">
                                  {tasks.filter((t) => t.status === "done").length}/{tasks.length}
                                </span>
                              </button>
                              <AnimatePresence initial={false}>
                                {!goalCollapsed && tasks.length > 0 && (
                                  <motion.ul
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ type: "spring", stiffness: 600, damping: 49 }}
                                    className="m-0 list-none overflow-hidden p-0"
                                  >
                                    {tasks.map((task) => (
                                      <li key={task.id}>
                                        <button
                                          type="button"
                                          data-testid={`navigator-task-${task.id}`}
                                          onClick={() => onTaskClick?.(task)}
                                          className="flex w-full items-center gap-2 py-1 pl-12 pr-3 text-left text-[10px] text-[var(--dim)] transition-colors hover-only:hover:bg-[var(--surface-hover)] hover-only:hover:text-[var(--fg)] focus-visible:focus-ring"
                                        >
                                          <CircleDot
                                            aria-hidden="true"
                                            size={9}
                                            strokeWidth={1.6}
                                            className="shrink-0"
                                            style={{ color: colorFor(task.status) }}
                                          />
                                          <span className="min-w-0 flex-1 truncate">
                                            {task.id} · {task.title}
                                          </span>
                                        </button>
                                      </li>
                                    ))}
                                  </motion.ul>
                                )}
                              </AnimatePresence>
                            </motion.li>
                          );
                        })}
                        {group.unassignedTasks.map((task) => (
                          <li key={task.id}>
                            <button
                              type="button"
                              data-testid={`navigator-task-${task.id}`}
                              onClick={() => onTaskClick?.(task)}
                              className="flex w-full items-center gap-2 py-1 pl-12 pr-3 text-left text-[10px] text-[var(--dim)] transition-colors hover-only:hover:bg-[var(--surface-hover)] hover-only:hover:text-[var(--fg)] focus-visible:focus-ring"
                            >
                              <CircleDot
                                aria-hidden="true"
                                size={9}
                                strokeWidth={1.6}
                                className="shrink-0"
                                style={{ color: colorFor(task.status) }}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {task.id} · {task.title}
                              </span>
                            </button>
                          </li>
                        ))}
                      </motion.ul>
                    )}
                  </AnimatePresence>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-3 text-[11px] text-[var(--dim)]">
                {deferredQuery ? "no matches" : "no milestones, goals, or tasks yet"}
              </li>
            )}
          </ul>
        </>
      )}
    </NavigatorShell>
  );
}
