/**
 * Lightweight polled fetcher for the daemon's project + events
 * endpoints. Returns Solid signals the v2 view wrappers feed into the
 * widget mounts.
 *
 * Why polling and not the WebSocket bus? The bus port belongs to a
 * later phase (see InspectorPlaceholder comment in the route). 5 s
 * polling is enough to wire the placeholders to live data; the bus
 * swap-in keeps the same prop shape so no widget call sites change.
 */

import { createSignal, onCleanup } from "solid-js";
import { API_BASE } from "@/lib/api";

export interface ProjectDetailLike {
  session: string;
  dir?: string;
  mission?: {
    title?: string;
    description?: string;
    status?: string;
    branch?: string | null;
    milestones?: Array<{
      id: string;
      title: string;
      status: string;
      order?: number;
      taskCount?: number;
      tasksDone?: number;
    }>;
  } | null;
  goals?: Array<{ id: string; title: string }>;
  tasks?: Array<{
    id: string;
    title: string;
    status: string;
    priority?: number;
    assignee?: string | null;
    goal?: string | null;
    milestone?: string | null;
    depends_on?: string[];
    tags?: string[];
    description?: string | null;
    created?: string;
    updated?: string;
    proof?: unknown;
  }>;
  agents?: Array<{
    paneTitle: string;
    paneId: string;
    isBusy: boolean;
    taskTitle: string | null;
    taskId: string | null;
    elapsed: string;
  }>;
  milestones?: Array<{
    id: string;
    title: string;
    status: string;
    order?: number;
    taskCount?: number;
    tasksDone?: number;
  }>;
  validationSummary?: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
    blocked: number;
  };
  skills?: Array<{ name: string; specialties?: string[] }>;
}

export interface ProjectEventLike {
  timestamp: string;
  type: string;
  message: string;
  agent?: string | null;
  taskId?: string;
  relative?: string;
}

interface PollerOpts {
  intervalMs?: number;
}

async function safeJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${url}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Polls `/api/project/:name` every `intervalMs` (default 5 s). Stops
 * automatically on Solid cleanup.
 */
export function createProjectDetail(
  projectName: () => string,
  opts: PollerOpts = {},
): {
  detail: () => ProjectDetailLike | null;
  refresh: () => Promise<void>;
} {
  const interval = opts.intervalMs ?? 5000;
  const [detail, setDetail] = createSignal<ProjectDetailLike | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  async function tick(): Promise<void> {
    const name = projectName();
    if (!name) return;
    const data = await safeJson<ProjectDetailLike>(`/api/project/${encodeURIComponent(name)}`);
    if (!cancelled && data) setDetail(data);
  }

  void tick();
  timer = setInterval(tick, interval);

  onCleanup(() => {
    cancelled = true;
    if (timer) clearInterval(timer);
  });

  return { detail, refresh: tick };
}

/**
 * Polls `/api/project/:name/events` every `intervalMs` (default 4 s).
 */
export function createProjectEvents(
  projectName: () => string,
  opts: PollerOpts = {},
): { events: () => ProjectEventLike[] } {
  const interval = opts.intervalMs ?? 4000;
  const [events, setEvents] = createSignal<ProjectEventLike[]>([]);
  let timer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  async function tick(): Promise<void> {
    const name = projectName();
    if (!name) return;
    const data = await safeJson<{ events?: ProjectEventLike[] }>(
      `/api/project/${encodeURIComponent(name)}/events`,
    );
    if (!cancelled && data?.events) setEvents(data.events);
  }

  void tick();
  timer = setInterval(tick, interval);

  onCleanup(() => {
    cancelled = true;
    if (timer) clearInterval(timer);
  });

  return { events };
}

export interface SkillDetailLike {
  name: string;
  role?: string;
  description?: string;
  specialties?: string[];
  body?: string;
}

export async function fetchSkill(
  projectName: string,
  skillName: string,
): Promise<SkillDetailLike | null> {
  return safeJson<SkillDetailLike>(
    `/api/project/${encodeURIComponent(projectName)}/skills/${encodeURIComponent(skillName)}`,
  );
}

export interface MetricsLike {
  session?: {
    startedAt: string | null;
    durationMs: number;
    status: string;
    agentCount: number;
  };
  tasks?: {
    total: number;
    completed: number;
    failed: number;
    retried: number;
    completionRate: number;
    retryRate: number;
    avgDurationMs: number;
    medianDurationMs: number;
    p90DurationMs: number;
    byMilestone: unknown[];
  };
  agents?: unknown[];
  mission?: {
    title: string | null;
    status: string | null;
    milestonesCompleted: number;
    validationPassRate: number;
    wallClockMs: number;
  };
  timeline?: unknown[];
}

export function createMetrics(
  projectName: () => string,
  opts: PollerOpts = {},
): { metrics: () => MetricsLike | null } {
  const interval = opts.intervalMs ?? 6000;
  const [metrics, setMetrics] = createSignal<MetricsLike | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  async function tick(): Promise<void> {
    const name = projectName();
    if (!name) return;
    const data = await safeJson<MetricsLike>(`/api/project/${encodeURIComponent(name)}/metrics`);
    if (!cancelled && data) setMetrics(data);
  }

  void tick();
  timer = setInterval(tick, interval);

  onCleanup(() => {
    cancelled = true;
    if (timer) clearInterval(timer);
  });

  return { metrics };
}
