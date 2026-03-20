"use client";

import { useState, useEffect, useRef } from "react";
import type { Task } from "@/lib/types";

interface ActivityEntry {
  id: string;
  time: number;
  message: string;
}

function formatRelative(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

interface ActivityFeedProps {
  tasks: Task[];
  maxEntries?: number;
}

export function ActivityFeed({ tasks, maxEntries = 20 }: ActivityFeedProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const prevRef = useRef<Map<string, { status: string; assignee: string | null }>>(new Map());
  const counterRef = useRef(0);

  useEffect(() => {
    const prev = prevRef.current;
    const now = Date.now();
    const newEntries: ActivityEntry[] = [];

    for (const t of tasks) {
      const old = prev.get(t.id);
      if (!old) continue; // Skip first load
      if (old.status !== t.status) {
        const label =
          t.status === "done"
            ? `✓ ${t.title}`
            : t.status === "in-progress"
              ? `→ ${t.title} started`
              : `${t.title} → ${t.status}`;
        newEntries.push({ id: `${++counterRef.current}`, time: now, message: label });
      } else if (old.assignee !== t.assignee && t.assignee) {
        newEntries.push({
          id: `${++counterRef.current}`,
          time: now,
          message: `${t.assignee} claimed ${t.id}`,
        });
      }
    }

    const next = new Map<string, { status: string; assignee: string | null }>();
    for (const t of tasks) next.set(t.id, { status: t.status, assignee: t.assignee });
    prevRef.current = next;

    if (newEntries.length > 0) {
      setEntries((prev) => [...newEntries, ...prev].slice(0, maxEntries));
    }
  }, [tasks, maxEntries]);

  // Refresh relative times
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(id);
  }, []);

  if (entries.length === 0) {
    return <div className="text-[var(--dim)]">Watching for changes…</div>;
  }

  return (
    <div className="space-y-0.5">
      {entries.map((e) => (
        <div key={e.id} className="flex gap-2">
          <span className="text-[var(--dim)] w-[4ch] text-right shrink-0">
            {formatRelative(e.time)}
          </span>
          <span className="text-[var(--fg)] truncate">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
