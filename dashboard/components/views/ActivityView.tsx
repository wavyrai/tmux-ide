"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EventData } from "@/lib/api";
import { useSessionStream } from "@/lib/useSessionStream";
import {
  EmptyState,
  KpiCard,
  Panel,
  PanelBody,
  SectionHeader,
  StatusPill,
  type StatusPillVariant,
} from "@/components/ui";

interface ActivityViewProps {
  sessionName: string;
}

const EMPTY_EVENTS: EventData[] = [];

type KpiFilter = "all" | "hour" | "day" | "agents" | "types";

const EVENT_META: Record<string, { label: string; color: string; bg: string }> = {
  dispatch: { label: "dispatch", color: "var(--accent)", bg: "rgba(97, 175, 239, 0.1)" },
  completion: { label: "complete", color: "var(--green)", bg: "rgba(155, 205, 151, 0.1)" },
  error: { label: "error", color: "var(--red)", bg: "rgba(252, 83, 58, 0.1)" },
  stall: { label: "stall", color: "var(--yellow)", bg: "rgba(252, 213, 58, 0.1)" },
  retry: { label: "retry", color: "var(--yellow)", bg: "rgba(252, 213, 58, 0.1)" },
  reconcile: { label: "reconcile", color: "var(--cyan)", bg: "rgba(86, 182, 194, 0.1)" },
  task_created: { label: "task created", color: "var(--dim)", bg: "var(--surface)" },
  status_change: { label: "status", color: "var(--dim)", bg: "var(--surface)" },
};

const DEFAULT_META = { label: "event", color: "var(--dim)", bg: "var(--surface)" };

function eventTime(event: EventData): number {
  const time = new Date(event.timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatMessage(event: EventData): string {
  if (event.message) return event.message;
  const parts: string[] = [];
  if (event.agent) parts.push(event.agent);
  if (event.type === "dispatch") parts.push("dispatched");
  if (event.type === "completion") parts.push("completed");
  if (event.type === "stall") parts.push("stalled on");
  if (event.type === "retry") parts.push("retrying");
  if (event.type === "reconcile") parts.push("released");
  if (event.taskId) parts.push(`task ${event.taskId}`);
  return parts.join(" ") || event.type;
}

function formatRelative(event: EventData): string {
  if (event.relative) return event.relative;
  const delta = Date.now() - eventTime(event);
  if (!Number.isFinite(delta)) return "";
  if (delta < 60_000) return `${Math.max(0, Math.floor(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function fullTimestamp(event: EventData): string {
  const date = new Date(event.timestamp);
  if (Number.isNaN(date.getTime())) return event.timestamp;
  return date.toLocaleString();
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toDateString();
}

function dayLabel(key: string): string {
  const day = new Date(key);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function eventVariant(type: string): StatusPillVariant {
  if (type === "completion") return "success";
  if (type === "error") return "error";
  if (type === "stall" || type === "retry") return "warning";
  if (type === "dispatch") return "active";
  if (type === "reconcile") return "info";
  return "pending";
}

export function ActivityView({ sessionName }: ActivityViewProps) {
  const { snapshot } = useSessionStream(sessionName);
  const events = snapshot?.events ?? EMPTY_EVENTS;
  const [kpiFilter, setKpiFilter] = useState<KpiFilter>("all");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const baseEvents = useMemo(
    () =>
      (events ?? [])
        .filter((event) => event.type !== "agent_heartbeat")
        .sort((a, b) => eventTime(b) - eventTime(a)),
    [events],
  );

  const stats = useMemo(() => {
    const now = Date.now();
    const hour = baseEvents.filter((event) => now - eventTime(event) <= 3_600_000).length;
    const day = baseEvents.filter((event) => now - eventTime(event) <= 86_400_000).length;
    const agents = new Set(baseEvents.flatMap((event) => (event.agent ? [event.agent] : [])));
    const types = new Set(baseEvents.map((event) => event.type));
    return { total: baseEvents.length, hour, day, agents: agents.size, types: types.size };
  }, [baseEvents]);

  const eventTypes = useMemo(
    () =>
      Array.from(new Set(baseEvents.map((event) => event.type))).sort((a, b) => a.localeCompare(b)),
    [baseEvents],
  );

  const filteredEvents = useMemo(() => {
    const now = Date.now();
    const normalizedQuery = query.trim().toLowerCase();
    return baseEvents.filter((event) => {
      const timestamp = eventTime(event);
      if (kpiFilter === "hour" && now - timestamp > 3_600_000) return false;
      if (kpiFilter === "day" && now - timestamp > 86_400_000) return false;
      if (kpiFilter === "agents" && !event.agent) return false;
      if (kpiFilter === "types" && !event.type) return false;
      if (selectedTypes.size > 0 && !selectedTypes.has(event.type)) return false;
      if (!normalizedQuery) return true;
      const haystack = [formatMessage(event), event.agent ?? "", event.type, event.taskId ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [baseEvents, kpiFilter, query, selectedTypes]);

  const groups = useMemo(() => {
    const grouped = new Map<string, EventData[]>();
    for (const event of filteredEvents) {
      const key = dayKey(eventTime(event));
      const rows = grouped.get(key) ?? [];
      rows.push(event);
      grouped.set(key, rows);
    }
    return Array.from(grouped.entries()).map(([key, rows]) => ({
      key,
      label: dayLabel(key),
      rows,
    }));
  }, [filteredEvents]);

  useEffect(() => {
    if (live && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [filteredEvents.length, live]);

  function toggleType(type: string) {
    setSelectedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    if (live && element.scrollTop > 48) setLive(false);
  }

  return (
    <Panel testId="activity-view">
      <PanelBody scrollable={false}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 space-y-5 overflow-auto p-4"
        >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-5">
          <KpiCard
            label="total events"
            value={stats.total}
            active={kpiFilter === "all"}
            testId="activity-kpi"
            onClick={() => setKpiFilter("all")}
          />
          <KpiCard
            label="last hour"
            value={stats.hour}
            active={kpiFilter === "hour"}
            color="var(--accent)"
            testId="activity-kpi"
            onClick={() => setKpiFilter("hour")}
          />
          <KpiCard
            label="last 24h"
            value={stats.day}
            active={kpiFilter === "day"}
            color="var(--cyan)"
            testId="activity-kpi"
            onClick={() => setKpiFilter("day")}
          />
          <KpiCard
            label="unique agents"
            value={stats.agents}
            active={kpiFilter === "agents"}
            color="var(--green)"
            testId="activity-kpi"
            onClick={() => setKpiFilter("agents")}
          />
          <KpiCard
            label="event types"
            value={stats.types}
            active={kpiFilter === "types"}
            color="var(--yellow)"
            testId="activity-kpi"
            onClick={() => setKpiFilter("types")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            data-testid="activity-filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search events"
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] px-3 text-[12px] text-[var(--fg)] outline-none placeholder:text-[var(--dimmer)] focus:border-[var(--accent)] md:min-w-56"
          />
          <button
            type="button"
            onClick={() => {
              setLive((value) => !value);
              requestAnimationFrame(() => {
                if (scrollRef.current) scrollRef.current.scrollTop = 0;
              });
            }}
            className={`h-8 rounded-md border px-3 text-[11px] uppercase tracking-[0.08em] ${
              live
                ? "border-[var(--green)] bg-[rgba(155,205,151,0.1)] text-[var(--green)]"
                : "border-[var(--border-weak)] bg-[var(--bg-strong)] text-[var(--dim)]"
            }`}
          >
            Live
          </button>
          {eventTypes.map((type) => {
            const active = selectedTypes.has(type);
            const meta = EVENT_META[type] ?? DEFAULT_META;
            return (
              <button
                key={type}
                type="button"
                data-testid="activity-filter"
                onClick={() => toggleType(type)}
                className={`h-7 rounded-md border px-2 text-[11px] transition-colors ${
                  active
                    ? "border-[var(--accent)] bg-[var(--surface-active)]"
                    : "border-[var(--border-weak)] bg-[var(--bg-strong)] hover:bg-[var(--surface-hover)]"
                }`}
                style={{ color: active ? "var(--accent)" : meta.color }}
              >
                {type.replaceAll("_", " ")}
              </button>
            );
          })}
          {(selectedTypes.size > 0 || query || kpiFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setKpiFilter("all");
                setSelectedTypes(new Set());
                setQuery("");
              }}
              className="h-7 rounded-md border border-[var(--border-weak)] px-2 text-[11px] text-[var(--dim)] hover:text-[var(--fg)]"
            >
              clear
            </button>
          )}
        </div>
        {groups.length === 0 ? (
          <EmptyState
            title="No activity yet"
            body="New dispatches, completions, retries, and errors will appear here."
          />
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.key}>
                <SectionHeader
                  label={group.label}
                  rightSlot={
                    <span className="text-[10px] tabular-nums text-[var(--dim)]">
                      {group.rows.length}
                    </span>
                  }
                  className="sticky top-0 z-10 bg-[var(--bg)] py-1"
                />
                <div className="divide-y divide-[var(--border-weak)] overflow-hidden rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)]">
                  {group.rows.map((event, index) => {
                    const meta = EVENT_META[event.type] ?? DEFAULT_META;
                    const label = (EVENT_META[event.type]?.label ?? event.type).replaceAll(
                      "_",
                      " ",
                    );
                    return (
                      <div
                        key={`${event.timestamp}-${event.type}-${index}`}
                        data-testid="activity-event"
                        className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 hover:bg-[var(--surface-hover)]"
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: meta.color }}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <StatusPill
                              variant={eventVariant(event.type)}
                              label={label}
                              dot={false}
                            />
                            <span className="truncate text-[12px] text-[var(--fg)]">
                              {formatMessage(event)}
                            </span>
                          </div>
                          <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-[var(--dim)]">
                            {event.agent && (
                              <span className="rounded-md bg-[var(--surface)] px-1.5 py-0.5 text-[var(--cyan)]">
                                @{event.agent}
                              </span>
                            )}
                            {event.taskId && <code>{event.taskId}</code>}
                          </div>
                        </div>
                        <time
                          dateTime={event.timestamp}
                          title={fullTimestamp(event)}
                          className="text-right text-[11px] tabular-nums text-[var(--dim)]"
                        >
                          {formatRelative(event)}
                        </time>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
        </div>
      </PanelBody>
    </Panel>
  );
}
