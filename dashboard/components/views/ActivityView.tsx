"use client";

import { useCallback } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import { fetchEvents, type EventData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

interface ActivityViewProps {
  sessionName: string;
}

export function ActivityView({ sessionName }: ActivityViewProps) {
  const eventsFetcher = useCallback(() => fetchEvents(sessionName), [sessionName]);
  const { data: events } = usePolling<EventData[]>(eventsFetcher, 3000);

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden">
      <ActivityFeed events={events ?? []} />
    </div>
  );
}
