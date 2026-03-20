import type { SessionOverview, ProjectDetail } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5050";

export async function fetchSessions(): Promise<SessionOverview[]> {
  const res = await fetch(`${API_BASE}/api/sessions`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { sessions: SessionOverview[] };
  return data.sessions;
}

export async function fetchProject(
  name: string,
): Promise<ProjectDetail | null> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return null;
  return (await res.json()) as ProjectDetail;
}

export interface DiffData {
  diff: string;
  files: { file: string; additions: number; deletions: number }[];
}

export async function fetchDiff(name: string): Promise<DiffData | null> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/diff`,
    { cache: "no-store" },
  );
  if (!res.ok) return null;
  return (await res.json()) as DiffData;
}

export async function fetchFileDiff(
  name: string,
  filePath: string,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(name)}/diff/${encodeURIComponent(filePath)}`,
    { cache: "no-store" },
  );
  if (!res.ok) return "";
  const data = (await res.json()) as { file: string; diff: string };
  return data.diff;
}

export async function updateTask(
  sessionName: string,
  taskId: string,
  fields: { status?: string; assignee?: string },
): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/api/project/${encodeURIComponent(sessionName)}/task/${encodeURIComponent(taskId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    },
  );
  return res.ok;
}
