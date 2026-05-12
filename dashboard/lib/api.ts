import type { SessionOverview, ProjectDetail, Task, Mark, AuthorshipStats } from "./types";
import type { AgentProvider, ThreadIndexEntry, ThreadState } from "@/components/chat/types";

/**
 * Provider discovery summary served by the daemon at `/api/chat/providers`.
 *
 * This is the ACP-discoverable provider shape (claude-code / codex binaries
 * found on PATH) — NOT the redacted T079 `ProviderInstanceSummary` for
 * user-configured provider instances (those are served separately at
 * `/api/providers` and shown in the ProvidersPanel). The two surfaces stay
 * distinct on purpose: this one drives the new-chat picker; the other
 * drives provider-instance management.
 */
export interface ProviderInfo {
  kind: "claude-code" | "codex";
  name: string;
  description: string;
  available: boolean;
  binary?: string;
  version?: string;
  error?: string;
}

/**
 * Project registry contract — mirrors the frozen REST + WS protocol that
 * Agent 1 implements server-side. Defined here as a stub because the
 * `@tmux-ide/schemas` package may not have shipped these types yet at the
 * time this client lands; once it does, swap the import.
 */
export interface RegisteredProject {
  name: string;
  dir: string;
  hasIdeYml: boolean;
  gitOrigin: string | null;
  gitBranch: string | null;
  registeredAt: string;
}

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
}

function resolveApiBase(): string {
  // Explicit env wins — useful for dev pointing at a remote daemon.
  const explicit = process.env.NEXT_PUBLIC_API_URL;
  if (explicit) return explicit;
  // SSR / build time — fetches won't run; safe to return "".
  if (typeof window === "undefined") return "";
  // Default: command-center is exposed on port 6060 of whatever hostname
  // the dashboard was loaded from. Works for localhost, Tailscale MagicDNS,
  // direct tailnet IP, etc. — no per-host env config required.
  //
  // BUT: when the dashboard hostname is "localhost", browsers (Chrome on
  // macOS especially) try IPv6 ([::1]) first. If the daemon binds IPv4-
  // only (`*:6060` = 0.0.0.0), every cross-origin request hangs on the
  // IPv6 attempt before falling back. Pin to 127.0.0.1 explicitly when
  // the page is on localhost to skip the IPv6 lookup entirely.
  const port = process.env.NEXT_PUBLIC_API_PORT ?? "6060";
  const host = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
  return `${window.location.protocol}//${host}:${port}`;
}

export const API_BASE = resolveApiBase();

export async function fetchSessions(): Promise<SessionOverview[]> {
  const res = await fetch(`${API_BASE}/api/sessions`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { sessions: SessionOverview[] };
  return data.sessions;
}

// ---------------------------------------------------------------------------
// Chat thread + provider client — talks to /api/threads and /api/chat/providers
// on the daemon. Used by V2ChatView (thread rail / chrome) and NewChatPicker.
// ---------------------------------------------------------------------------

export async function chatThreadList(): Promise<{ threads: ThreadIndexEntry[] }> {
  const res = await fetch(`${API_BASE}/api/threads`, { cache: "no-store" });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to list threads (HTTP ${res.status})`),
      res.status,
    );
  }
  const data = (await res.json()) as { threads?: ThreadIndexEntry[] };
  return { threads: Array.isArray(data.threads) ? data.threads : [] };
}

export interface ChatThreadCreateInput {
  provider: AgentProvider;
  title?: string;
  projectDir?: string;
}

export async function chatThreadCreate(
  input: ChatThreadCreateInput,
): Promise<{ thread: ThreadIndexEntry; state: ThreadState }> {
  const res = await fetch(`${API_BASE}/api/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to create thread (HTTP ${res.status})`),
      res.status,
    );
  }
  const data = (await res.json()) as { thread: ThreadIndexEntry; state: ThreadState };
  return { thread: data.thread, state: data.state };
}

export async function chatThreadDelete(input: { id: string }): Promise<void> {
  const res = await fetch(`${API_BASE}/api/threads/${encodeURIComponent(input.id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to delete thread (HTTP ${res.status})`),
      res.status,
    );
  }
}

// Send a user prompt to a thread. Mirrors the daemon action contract
// (chat.session.send): { threadId, content: ContentBlock[] }. The composer
// passes plain text; we wrap it in a single text content block.
export async function chatSessionSend(input: {
  threadId: string;
  text: string;
}): Promise<{ accepted: true; promptId: string }> {
  const res = await fetch(`${API_BASE}/api/v2/action/chat.session.send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: input.threadId,
      content: [{ type: "text", text: input.text }],
    }),
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to send (HTTP ${res.status})`),
      res.status,
    );
  }
  const envelope = (await res.json()) as
    | { ok: true; result: { accepted: true; promptId: string } }
    | { ok: false; error: { message: string } };
  if ("ok" in envelope && envelope.ok === false) {
    throw new ProjectApiError(envelope.error.message, res.status);
  }
  return (envelope as { ok: true; result: { accepted: true; promptId: string } }).result;
}

export async function chatProvidersList(): Promise<{ providers: ProviderInfo[] }> {
  const res = await fetch(`${API_BASE}/api/chat/providers`, { cache: "no-store" });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to list providers (HTTP ${res.status})`),
      res.status,
    );
  }
  const data = (await res.json()) as { providers?: ProviderInfo[] };
  return { providers: Array.isArray(data.providers) ? data.providers : [] };
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
  const data = (await res.json()) as { panes?: PaneData[] };
  return Array.isArray(data.panes) ? data.panes : [];
}

export async function fetchProject(name: string): Promise<ProjectDetail | null> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as ProjectDetail;
}

export async function injectIntoProject(
  name: string,
  text: string,
  opts: { paneId?: string; sendEnter?: boolean } = {},
): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...opts }),
  });
  return res.ok;
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
  owner?: string | null;
  updated?: string | null;
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

export async function updatePlanStatus(
  name: string,
  filename: string,
  status: PlanStatus,
): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/plans/${encodeURIComponent(filename)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
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
  mtime?: number | null;
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
    mtime?: number | null;
  };

  let authorship: AuthorshipData | null = null;
  if (data.marks && data.stats) {
    authorship = {
      sections: marksToSections(data.marks, data.content),
      stats: data.stats,
    };
  }

  return { content: data.content, authorship, mtime: data.mtime ?? null };
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

export async function fetchSkill(name: string, skillName: string): Promise<SkillData | null> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/skills/${encodeURIComponent(skillName)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { skill?: SkillData };
  return data.skill ?? null;
}

export async function fetchSkills(name: string): Promise<SkillData[]> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/skills`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { skills?: SkillData[] };
  return Array.isArray(data.skills) ? data.skills : [];
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
  const data = (await res.json()) as Partial<MissionDetail> | null;
  if (!data || typeof data !== "object" || !data.mission || !data.validationSummary) return null;
  return data as MissionDetail;
}

export async function planComplete(name: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/mission/plan-complete`,
    { method: "POST" },
  );
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    return { ok: false, error: message };
  }
  return { ok: true };
}

export async function setMission(
  name: string,
  fields: { title: string; description?: string; branch?: string | null; status?: string },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/mission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    return { ok: false, error: message };
  }
  return { ok: true };
}

export async function clearMission(name: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/mission`, {
    method: "DELETE",
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    return { ok: false, error: message };
  }
  return { ok: true };
}

export async function createMilestone(
  name: string,
  fields: { title: string; description?: string; sequence: number },
): Promise<{ ok: boolean; milestone?: MilestoneData; error?: string }> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/milestones`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    return { ok: false, error: message };
  }
  const data = (await res.json()) as { ok: boolean; milestone: MilestoneData };
  return { ok: true, milestone: data.milestone };
}

export async function updateMilestone(
  name: string,
  milestoneId: string,
  fields: { title?: string; description?: string; status?: MilestoneData["status"] },
): Promise<{ ok: boolean; milestone?: MilestoneData; error?: string }> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/milestones/${encodeURIComponent(milestoneId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    },
  );
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    return { ok: false, error: message };
  }
  const data = (await res.json()) as { ok: boolean; milestone: MilestoneData };
  return { ok: true, milestone: data.milestone };
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

export async function createPlan(
  name: string,
  filename: string,
  content: string,
): Promise<{ ok: boolean; mtime?: number | null }> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/plans/${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) return { ok: false };
  const data = (await res.json()) as { ok: boolean; mtime?: number | null };
  return data;
}

export async function savePlanContent(
  name: string,
  filename: string,
  content: string,
): Promise<{ ok: boolean; mtime?: number | null }> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/plans/${encodeURIComponent(filename)}/content`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) return { ok: false };
  const data = (await res.json()) as { ok: boolean; mtime?: number | null };
  return data;
}

export async function deletePlan(name: string, filename: string): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/plans/${encodeURIComponent(filename)}`,
    { method: "DELETE" },
  );
  return res.ok;
}

// --- Project registry ---

export class ProjectApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
  }
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; message?: string };
    return data.error ?? data.message ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchProjects(): Promise<RegisteredProject[]> {
  const res = await fetch(`${API_BASE}/api/projects`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { projects?: RegisteredProject[] };
  return Array.isArray(data.projects) ? data.projects : [];
}

export async function registerProject(dir: string, name?: string): Promise<RegisteredProject> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name ? { dir, name } : { dir }),
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to register project (HTTP ${res.status})`),
      res.status,
    );
  }
  const data = (await res.json()) as { project: RegisteredProject };
  return data.project;
}

export async function probeProject(dirOrName: string): Promise<RegisteredProject> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(dirOrName)}/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: dirOrName }),
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to probe project (HTTP ${res.status})`),
      res.status,
    );
  }
  const data = (await res.json()) as { project: RegisteredProject };
  return data.project;
}

export async function unregisterProject(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to unregister project (HTTP ${res.status})`),
      res.status,
    );
  }
}

export async function initProject(dir: string, template?: string): Promise<{ jobId: string }> {
  const res = await fetch(`${API_BASE}/api/projects/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(template ? { dir, template } : { dir }),
  });
  if (!res.ok && res.status !== 202) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to start init (HTTP ${res.status})`),
      res.status,
    );
  }
  const data = (await res.json()) as { jobId?: string };
  if (!data.jobId) {
    throw new ProjectApiError("Server did not return a jobId", 500);
  }
  return { jobId: data.jobId };
}

/**
 * Registry-agnostic directory inspection. Mirrors `POST
 * /api/filesystem/inspect`. Used by the AddProjectDialog "Open existing"
 * tab to peek at a directory before deciding whether to register it
 * (`hasIdeYml=true` → register flow) or onboard it (`false` → wizard).
 */
export interface ProjectInspectDetected {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  frameworks: string[];
  devCommand: string | null;
  testCommand: string | null;
}

export interface ProjectInspect {
  name: string;
  dir: string;
  hasIdeYml: boolean;
  gitOrigin: string | null;
  gitBranch: string | null;
  detected: ProjectInspectDetected;
}

export async function inspectDirectory(dir: string): Promise<ProjectInspect> {
  const res = await fetch(`${API_BASE}/api/filesystem/inspect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to inspect directory (HTTP ${res.status})`),
      res.status,
    );
  }
  const data = (await res.json()) as { project: ProjectInspect };
  return data.project;
}

export interface OnboardProjectInput {
  dir: string;
  name?: string;
  agents: number;
  /** Optional per-agent pane titles. Length must equal `agents` when set. */
  agentNames?: string[];
  devCommand?: string | null;
  testCommand?: string | null;
  /** Optional lint command. Currently informational; stored for later. */
  lintCommand?: string | null;
}

export async function onboardProject(input: OnboardProjectInput): Promise<RegisteredProject> {
  const res = await fetch(`${API_BASE}/api/projects/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to onboard project (HTTP ${res.status})`),
      res.status,
    );
  }
  const data = (await res.json()) as { project: RegisteredProject };
  return data.project;
}

export async function fetchProjectTemplates(): Promise<ProjectTemplate[]> {
  const res = await fetch(`${API_BASE}/api/projects/templates`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { templates?: ProjectTemplate[] };
  return Array.isArray(data.templates) ? data.templates : [];
}

// ---------------------------------------------------------------------------
// Filesystem browser — server-driven directory picker
// ---------------------------------------------------------------------------

export interface FilesystemEntry {
  name: string;
  fullPath: string;
  isDir: boolean;
  isSymlink: boolean;
}

export interface FilesystemBrowseResult {
  path: string;
  parentPath: string | null;
  entries: FilesystemEntry[];
}

/**
 * Browse a directory on the server. Pass `path` empty/undefined to list the
 * user's home (the daemon decides — never trust the client to know HOME).
 * Throws `ProjectApiError` on 4xx/5xx so callers can surface the message.
 */
export async function fetchFilesystem(
  path?: string,
  showHidden?: boolean,
): Promise<FilesystemBrowseResult> {
  const params = new URLSearchParams();
  if (path && path.length > 0) params.set("path", path);
  if (showHidden) params.set("showHidden", "true");
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/api/filesystem/browse${qs ? `?${qs}` : ""}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new ProjectApiError(
      await readErrorMessage(res, `Failed to browse (HTTP ${res.status})`),
      res.status,
    );
  }
  return (await res.json()) as FilesystemBrowseResult;
}

// ---------------------------------------------------------------------------
// Files + Preview (v2 widgets)
// ---------------------------------------------------------------------------

export interface ProjectFileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ProjectFileNode[];
  truncated?: true;
}

export async function fetchProjectFiles(name: string): Promise<ProjectFileNode[]> {
  const res = await fetch(`${API_BASE}/api/project/${encodeURIComponent(name)}/files`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { tree?: ProjectFileNode[] };
  return data.tree ?? [];
}

export interface FilePreview {
  file: string;
  exists: boolean;
  content: string;
  size?: number;
  mtimeMs?: number;
}

export async function fetchFilePreview(
  name: string,
  filePath: string,
): Promise<FilePreview | null> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/preview/${filePath.split("/").map(encodeURIComponent).join("/")}`,
    { cache: "no-store" },
  );
  if (!res.ok) return null;
  return (await res.json()) as FilePreview;
}

// ---------------------------------------------------------------------------
// Widget spawn — used by /v2/widget/[name] mirror page to ask the daemon
// where the widget binary lives + how to invoke it. The page then drives a
// Terminal via the same protocol the tmux panes use.
// ---------------------------------------------------------------------------

export interface WidgetSpawnSpec {
  cwd: string;
  cmd: string[];
}

export async function fetchWidgetSpawn(
  name: string,
  query: { session: string; dir: string; target?: string | null; theme?: unknown },
): Promise<WidgetSpawnSpec> {
  const params = new URLSearchParams();
  params.set("session", query.session);
  params.set("dir", query.dir);
  if (query.target) params.set("target", query.target);
  if (query.theme !== undefined) params.set("theme", JSON.stringify(query.theme));
  const res = await fetch(
    `${API_BASE}/api/widget/${encodeURIComponent(name)}/spawn?${params.toString()}`,
    { cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorMessage(res, `Failed to spawn widget ${name} (HTTP ${res.status})`),
    );
  }
  return (await res.json()) as WidgetSpawnSpec;
}

// ---------------------------------------------------------------------------
// TurnDiff projection client (T101a) — talks to /api/project/:name/turn-diffs/*
// on the daemon. Used by chat-v2 to render the "changed files" panel for
// each turn that produced a checkpoint.
// ---------------------------------------------------------------------------

/** Mirror of the daemon's TurnDiffEntry — see packages/daemon/src/persistence/projections/turn-diff-projection.ts. */
export interface TurnDiffEntry {
  threadId: string;
  turnId: string;
  fileIndex: number;
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  rawKind: string;
}

export interface TurnDiffAggregate {
  totalAdditions: number;
  totalDeletions: number;
  filesChanged: number;
}

export async function fetchTurnDiffs(
  name: string,
  turnId: string,
): Promise<TurnDiffEntry[]> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/turn-diffs/${encodeURIComponent(turnId)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { turnId: string; entries: TurnDiffEntry[] };
  return body.entries;
}

export async function fetchThreadTurnDiffs(
  name: string,
  threadId: string,
): Promise<Record<string, TurnDiffEntry[]>> {
  const params = new URLSearchParams({ threadId });
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/turn-diffs?${params.toString()}`,
    { cache: "no-store" },
  );
  if (!res.ok) return {};
  const body = (await res.json()) as {
    threadId: string;
    byTurn: Record<string, TurnDiffEntry[]>;
  };
  return body.byTurn;
}

export async function fetchThreadDiffAggregate(
  name: string,
  threadId: string,
): Promise<TurnDiffAggregate> {
  const params = new URLSearchParams({ threadId });
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/turn-diffs/aggregate?${params.toString()}`,
    { cache: "no-store" },
  );
  if (!res.ok) return { totalAdditions: 0, totalDeletions: 0, filesChanged: 0 };
  return (await res.json()) as TurnDiffAggregate;
}
