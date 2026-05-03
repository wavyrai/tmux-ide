"use client";

import { useSyncExternalStore } from "react";
import { Persist } from "./persist";
import type { ToastKind } from "@/lib/useToasts";

export type NotificationKind = ToastKind;

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  ts: number;
  timestamp: number;
  read: boolean;
  scope?: { project?: string };
}

export type NotificationInput = Omit<NotificationItem, "id" | "ts" | "timestamp" | "read"> &
  Partial<Pick<NotificationItem, "id" | "ts" | "timestamp" | "read">>;

interface PersistedNotifications {
  items: NotificationItem[];
}

const MAX_ITEMS = 500;
const TTL_MS = 1000 * 60 * 60 * 24 * 30;
const defaults: PersistedNotifications = { items: [] };
const persist = Persist.global<PersistedNotifications>("tmux-ide.notifications", ["v1"], defaults);

let seq = 0;
let items: NotificationItem[] = normalizeItems(persist.read().items);
const listeners = new Set<() => void>();

declare global {
  interface Window {
    __pushTestNotification?: (notification: NotificationInput) => string;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is NotificationKind {
  return value === "info" || value === "success" || value === "warning" || value === "error";
}

function normalizeItems(raw: unknown): NotificationItem[] {
  if (!Array.isArray(raw)) return [];
  const cutoff = Date.now() - TTL_MS;

  return raw
    .flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || !isKind(item.kind)) return [];
      if (typeof item.title !== "string") return [];
      const ts =
        typeof item.ts === "number"
          ? item.ts
          : typeof item.timestamp === "number"
            ? item.timestamp
            : null;
      if (ts === null || ts < cutoff) return [];
      return [
        {
          id: item.id,
          kind: item.kind,
          title: item.title,
          ...(typeof item.body === "string" ? { body: item.body } : {}),
          ts,
          timestamp: ts,
          read: typeof item.read === "boolean" ? item.read : false,
          ...(isRecord(item.scope)
            ? {
                scope: {
                  ...(typeof item.scope.project === "string"
                    ? { project: item.scope.project }
                    : {}),
                },
              }
            : {}),
        },
      ];
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ITEMS);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): NotificationItem[] {
  return items;
}

function nextId(): string {
  seq += 1;
  return `notification:${seq}`;
}

function persistItems(): void {
  items = normalizeItems(items);
  persist.write({ items });
}

function pushNotification(input: NotificationInput): string {
  const ts = input.ts ?? input.timestamp ?? Date.now();
  const notification: NotificationItem = {
    ...input,
    id: input.id ?? nextId(),
    ts,
    timestamp: ts,
    read: input.read ?? false,
  };
  items = [notification, ...items.filter((item) => item.id !== notification.id)];
  persistItems();
  emit();
  return notification.id;
}

function markNotificationRead(id: string): void {
  if (!items.some((item) => item.id === id && !item.read)) return;
  items = items.map((item) => (item.id === id ? { ...item, read: true } : item));
  persistItems();
  emit();
}

function markAllNotificationsRead(): void {
  if (!items.some((item) => !item.read)) return;
  items = items.map((item) => ({ ...item, read: true }));
  persistItems();
  emit();
}

function clearNotifications(): void {
  if (items.length === 0) return;
  items = [];
  persist.write({ items });
  emit();
}

if (typeof window !== "undefined") {
  window.__pushTestNotification = pushNotification;
}

export function useNotifications(): {
  items: NotificationItem[];
  unreadCount: number;
  push(notification: NotificationInput): string;
  markRead(id: string): void;
  markAllRead(): void;
  clear(): void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    items: snapshot,
    unreadCount: snapshot.filter((item) => !item.read).length,
    push: pushNotification,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
    clear: clearNotifications,
  };
}

export function __resetNotificationsForTests(next?: NotificationItem[]): void {
  seq = 0;
  items = normalizeItems(next ?? persist.read().items);
  emit();
}

export function __clearNotificationsForTests(): void {
  seq = 0;
  items = [];
  persist.clear();
  emit();
}
