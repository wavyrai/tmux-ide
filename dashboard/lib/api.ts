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
