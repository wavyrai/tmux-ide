"use client";

import { useRef, useEffect } from "react";
import type { EventData } from "@/lib/api";

const EVENT_ICONS: Record<string, { icon: string; color: string }> = {
  dispatch: { icon: ">", color: "var(--accent)" },
  completion: { icon: "✓", color: "var(--green)" },
  stall: { icon: "!", color: "var(--yellow)" },
  retry: { icon: "~", color: "var(--yellow)" },
  reconcile: { icon: "×", color: "var(--red)" },
  error: { icon: "✗", color: "var(--red)" },
  task_created: { icon: "+", color: "var(--dim)" },
  status_change: { icon: "—", color: "var(--dim)" },
};

const DEFAULT_ICON = { icon: "·", color: "var(--dim)" };

interface ActivityFeedProps {
  events: EventData[];
  maxEvents?: number;
}

export function ActivityFeed({ events, maxEvents = 50 }: ActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  // Auto-scroll to top when new events arrive
  useEffect(() => {
    if (events.length > prevLenRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    prevLenRef.current = events.length;
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        No activity yet
      </div>
    );
  }

  const visible = events.slice(0, maxEvents);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto py-1">
      {visible.map((e, i) => {
        const { icon, color } = EVENT_ICONS[e.type] ?? DEFAULT_ICON;

        return (
          <div
            key={`${e.timestamp}-${i}`}
            className="flex items-start h-6 px-3 hover:bg-[var(--surface-hover)]"
          >
            {/* Relative time */}
            <span className="w-[8ch] shrink-0 text-right text-[var(--dim)] pr-2">
              {e.relative ?? ""}
            </span>

            {/* Icon */}
            <span className="w-3 shrink-0 text-center" style={{ color }}>
              {icon}
            </span>

            {/* Message */}
            <span className="flex-1 truncate pl-1 text-[var(--fg)]">{formatMessage(e)}</span>
          </div>
        );
      })}
    </div>
  );
}

function formatMessage(e: EventData): string {
  // If the server already provides a good message, use it
  if (e.message) return e.message;

  // Fallback construction from fields
  const parts: string[] = [];
  if (e.agent) parts.push(e.agent);
  if (e.type === "dispatch") parts.push("dispatched");
  if (e.type === "completion") parts.push("completed");
  if (e.type === "stall") parts.push("stalled on");
  if (e.type === "retry") parts.push("retrying");
  if (e.type === "reconcile") parts.push("released");
  if (e.taskId) parts.push(`task ${e.taskId}`);
  return parts.join(" ");
}
