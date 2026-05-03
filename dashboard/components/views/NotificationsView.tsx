"use client";

import { useMemo, useState } from "react";
import {
  useNotifications,
  type NotificationItem,
  type NotificationKind,
} from "@/lib/useNotifications";
import {
  EmptyState,
  Panel,
  PanelBody,
  SectionHeader,
  StatusPill,
  SurfaceCard,
} from "@/components/ui";

type Filter = "all" | "unread" | NotificationKind;

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "info", label: "Info" },
  { id: "success", label: "Success" },
  { id: "warning", label: "Warning" },
  { id: "error", label: "Error" },
];

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return `${Math.max(1, Math.round(elapsed / 1000))}s ago`;
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
  return `${Math.round(elapsed / 86_400_000)}d ago`;
}

function matchesFilter(item: NotificationItem, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return !item.read;
  return item.kind === filter;
}

export function NotificationsView() {
  const { items, unreadCount, markRead, markAllRead, clear } = useNotifications();
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(
    () => items.filter((item) => matchesFilter(item, filter)),
    [filter, items],
  );

  return (
    <Panel testId="notifications-view">
      <PanelBody className="space-y-5 p-4">
        <SectionHeader
          label="Notifications"
          rightSlot={
            <span className="text-[11px] tabular-nums text-[var(--dim)]">{unreadCount} unread</span>
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              data-active={filter === item.id ? "true" : "false"}
              className={`h-7 rounded-md border px-2 text-[11px] transition-colors ${
                filter === item.id
                  ? "border-[var(--accent)] bg-[var(--surface-active)] text-[var(--accent)]"
                  : "border-[var(--border-weak)] bg-[var(--bg-strong)] text-[var(--dim)] hover:text-[var(--fg)]"
              }`}
            >
              {item.label}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={markAllRead}
            className="h-7 rounded-md border border-[var(--border-weak)] px-2 text-[11px] text-[var(--dim)] transition-colors hover:text-[var(--fg)]"
          >
            Mark all read
          </button>
          <button
            type="button"
            onClick={clear}
            className="h-7 rounded-md border border-[var(--border-weak)] px-2 text-[11px] text-[var(--dim)] transition-colors hover:text-[var(--red)]"
          >
            Clear
          </button>
        </div>
        {visible.length === 0 ? (
          <EmptyState title="No notifications" />
        ) : (
          <SurfaceCard padded={false} className="divide-y divide-[var(--border-weak)]">
            {visible.map((item) => (
              <div
                key={item.id}
                data-testid="notification-item"
                data-read={item.read ? "true" : "false"}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusPill
                      variant={item.kind}
                      label={item.kind}
                      dot={!item.read}
                      style={{ opacity: item.read ? 0.55 : 1 }}
                    />
                    <span className="truncate text-[13px] text-[var(--fg)]">{item.title}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--dim)]">
                      {relativeTime(item.timestamp)}
                    </span>
                  </div>
                  {item.body && (
                    <div className="mt-0.5 text-[12px] leading-5 text-[var(--dim)]">
                      {item.body}
                    </div>
                  )}
                </div>
                {!item.read && (
                  <button
                    type="button"
                    onClick={() => markRead(item.id)}
                    className="self-start rounded-md border border-[var(--border-weak)] px-2 py-1 text-[11px] text-[var(--dim)] transition-colors hover:text-[var(--accent)]"
                  >
                    mark read
                  </button>
                )}
              </div>
            ))}
          </SurfaceCard>
        )}
      </PanelBody>
    </Panel>
  );
}
