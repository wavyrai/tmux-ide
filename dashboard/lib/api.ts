import type { SessionOverview, ProjectDetail, Task, Mark, AuthorshipStats } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export async function fetchSessions(): Promise<SessionOverview[]> {
  const res = await fetch(`${API_BASE}/api/sessions`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { sessions: SessionOverview[] };
  return data.sessions;
}

export interface PaneData {
  id: string;
  index: number;
  title: string;
  currentCommand: string;
  width: number;
  height: number;
  active: boolean;
  role: string | null;
  name: string | null;
  type: string | null;
}

export async function fetchPanes(name: string): Promise<PaneData[]> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/panes`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { panes: PaneData[] };
  return data.panes;
}

export async function fetchProject(name: string): Promise<ProjectDetail | null> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as ProjectDetail;
}

export interface DiffData {
  diff: string;
  files: { file: string; additions: number; deletions: number }[];
}

export async function fetchDiff(name: string): Promise<DiffData | null> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/diff`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as DiffData;
}

export async function fetchFileDiff(name: string, filePath: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/diff/${encodeURIComponent(filePath)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return "";
  const data = (await res.json()) as { file: string; diff: string };
  return data.diff;
}

export interface EventData {
  timestamp: string;
  type: string;
  taskId?: string;
  agent?: string;
  message: string;
  relative: string;
}

export async function fetchEvents(name: string): Promise<EventData[]> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/events`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { events: EventData[] };
  return data.events;
}

export async function updateTask(
  sessionName: string,
  taskId: string,
  fields: {
    status?: string;
    assignee?: string;
    title?: string;
    description?: string;
    priority?: number;
  },
): Promise<Task | null> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(sessionName)}/task/${encodeURIComponent(taskId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { ok: boolean; task: Task };
  return data.task;
}

export async function createTask(
  sessionName: string,
  fields: {
    title: string;
    description?: string;
    priority?: number;
    goal?: string;
    tags?: string[];
  },
): Promise<Task | null> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(sessionName)}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { ok: boolean; task: Task };
  return data.task;
}

export type PlanStatus = "pending" | "in-progress" | "done" | "archived";

export interface PlanSummary {
  name: string;
  path: string;
  title: string;
  status: PlanStatus;
  effort: string | null;
  completed: string | null;
}

export async function fetchPlans(name: string): Promise<PlanSummary[]> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/plans`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { plans: PlanSummary[] };
  return data.plans;
}

export async function markPlanDone(name: string, filename: string): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/plans/${encodeURIComponent(filename)}/done`,
    { method: "POST" },
  );
  return res.ok;
}

export interface AuthorshipSection {
  author: string;
  at: string;
  charCount: number;
}

export interface AuthorshipData {
  sections: Record<string, AuthorshipSection>;
  stats: { aiPercent: number; humanPercent: number; totalChars: number };
}

export interface PlanData {
  content: string;
  authorship: AuthorshipData | null;
}

/**
 * Convert character-range marks into section-level authorship summaries.
 * Each section heading in the markdown gets attributed to the author
 * who wrote the most characters in that section.
 */
export function marksToSections(
  marks: Record<string, Mark>,
  content: string,
): Record<string, AuthorshipSection> {
  // Find section boundaries from heading lines
  const lines = content.split("\n");
  const sections: { heading: string; from: number; to: number }[] = [];
  let offset = 0;
  let currentHeading = "";
  let sectionStart = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      if (currentHeading || offset > 0) {
        sections.push({ heading: currentHeading, from: sectionStart, to: offset });
      }
      currentHeading = headingMatch[1]!.trim();
      sectionStart = offset;
    }
    offset += line.length + 1; // +1 for newline
  }
  sections.push({ heading: currentHeading, from: sectionStart, to: offset });

  // For each section, find the dominant author from overlapping marks
  const result: Record<string, AuthorshipSection> = {};
  const markList = Object.values(marks).filter((m) => !m.orphaned);

  for (const section of sections) {
    if (!section.heading) continue;
    const authorChars: Record<string, { chars: number; latestAt: string }> = {};

    for (const mark of markList) {
      const overlapFrom = Math.max(mark.range.from, section.from);
      const overlapTo = Math.min(mark.range.to, section.to);
      if (overlapFrom >= overlapTo) continue;

      const chars = overlapTo - overlapFrom;
      const existing = authorChars[mark.by];
      if (existing) {
        existing.chars += chars;
        if (mark.at > existing.latestAt) existing.latestAt = mark.at;
      } else {
        authorChars[mark.by] = { chars, latestAt: mark.at };
      }
    }

    // Pick the author with the most characters in this section
    let dominant: { author: string; chars: number; at: string } | null = null;
    for (const [author, data] of Object.entries(authorChars)) {
      if (!dominant || data.chars > dominant.chars) {
        dominant = { author, chars: data.chars, at: data.latestAt };
      }
    }

    if (dominant) {
      result[section.heading] = {
        author: dominant.author,
        at: dominant.at,
        charCount: dominant.chars,
      };
    }
  }

  return result;
}

export async function fetchPlan(name: string, filename: string): Promise<PlanData> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/plans/${encodeURIComponent(filename)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return { content: "", authorship: null };
  const data = (await res.json()) as {
    name: string;
    content: string;
    marks: Record<string, Mark> | null;
    stats: AuthorshipStats | null;
  };

  let authorship: AuthorshipData | null = null;
  if (data.marks && data.stats) {
    authorship = {
      sections: marksToSections(data.marks, data.content),
      stats: data.stats,
    };
  }

  return { content: data.content, authorship };
}

// --- Milestones ---

export interface MilestoneData {
  id: string;
  title: string;
  description: string;
  status: "locked" | "active" | "done" | "validating";
  order: number;
  taskCount: number;
  tasksDone: number;
}

export async function fetchMilestones(name: string): Promise<MilestoneData[]> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/milestones`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { milestones: MilestoneData[] };
  return data.milestones;
}

// --- Validation ---

export interface ValidationData {
  contract: string | null;
  state: {
    assertions: Record<
      string,
      { status: string; verifiedBy: string | null; evidence: string | null }
    >;
    lastVerified: string | null;
  } | null;
}

export interface CoverageData {
  unclaimed: string[];
  duplicates: Record<string, string[]>;
}

export async function fetchValidation(name: string): Promise<ValidationData | null> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/validation`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as ValidationData;
}

export async function fetchCoverage(name: string): Promise<CoverageData | null> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/validation/coverage`,
    { cache: "no-store" },
  );
  if (!res.ok) return null;
  return (await res.json()) as CoverageData;
}

// --- Skills ---

export interface SkillData {
  name: string;
  specialties: string[];
  role: string;
  description: string;
  body: string;
}

export async function fetchSkills(name: string): Promise<SkillData[]> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/skills`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { skills: SkillData[] };
  return data.skills;
}

// --- Mission ---

export interface MissionDetail {
  mission: {
    title: string;
    description: string;
    status: string;
    branch: string | null;
    milestones: MilestoneData[];
  };
  validationSummary: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
    blocked: number;
  };
}

export async function fetchMission(name: string): Promise<MissionDetail | null> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/mission`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as MissionDetail;
}

// --- Metrics ---

export interface AgentMetricsData {
  name: string;
  totalTimeMs: number;
  activeTimeMs: number;
  idleTimeMs: number;
  taskCount: number;
  retryCount: number;
  utilization: number;
  specialties: string[];
}

export interface MilestoneMetricsData {
  id: string;
  title: string;
  status: string;
  taskCount: number;
  completedCount: number;
  durationMs: number;
}

export interface TimelineEntryData {
  timestamp: string;
  completedTasks: number;
  activeTasks: number;
  busyAgents: number;
  idleAgents: number;
}

export interface MetricsData {
  session: { startedAt: string | null; durationMs: number; status: string; agentCount: number };
  tasks: {
    total: number;
    completed: number;
    failed: number;
    retried: number;
    completionRate: number;
    retryRate: number;
    avgDurationMs: number;
    medianDurationMs: number;
    p90DurationMs: number;
    byMilestone: MilestoneMetricsData[];
  };
  agents: AgentMetricsData[];
  mission: {
    title: string | null;
    status: string | null;
    milestonesCompleted: number;
    validationPassRate: number;
    wallClockMs: number;
  };
  timeline: TimelineEntryData[];
}

export async function fetchMetrics(name: string): Promise<MetricsData | null> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/metrics`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as MetricsData;
}

export async function deleteTaskApi(sessionName: string, taskId: string): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(sessionName)}/task/${encodeURIComponent(taskId)}`,
    { method: "DELETE" },
  );
  return res.ok;
}

export async function savePlan(name: string, filename: string, content: string): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/plans/${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return res.ok;
}

export async function deletePlan(name: string, filename: string): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/plans/${encodeURIComponent(filename)}`,
    { method: "DELETE" },
  );
  return res.ok;
}
