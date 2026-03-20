"use client";

import { useEffect, useState } from "react";
import { fetchSessions } from "@/lib/api";
import { ProjectCard } from "@/components/ProjectCard";
import type { SessionOverview } from "@/lib/types";

export default function OverviewPage() {
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const data = await fetchSessions();
        if (active) {
          setSessions(data);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      {error && (
        <div className="text-center text-[#e87d7d] py-4 mb-4 bg-[#1a1717] rounded-lg border border-[rgba(255,255,255,0.06)]">
          Cannot reach command center API. Is{" "}
          <code className="text-[#dcde8d]">tmux-ide command-center</code>{" "}
          running?
        </div>
      )}

      {sessions.length === 0 && !error && (
        <div className="text-center text-[#6b6363] py-20">
          No tmux-ide sessions running
        </div>
      )}

      <div className="space-y-4">
        {sessions.map((s) => (
          <ProjectCard key={s.name} session={s} />
        ))}
      </div>
    </main>
  );
}
