"use client";

import { useSyncExternalStore } from "react";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
  scope?: { project?: string };
}

export type ToastInput = Omit<Toast, "id"> & { id?: string };

const MAX_TOASTS = 50;
const DEFAULT_DURATION_MS = 5000;

let seq = 0;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Toast[] {
  return toasts;
}

function nextId(): string {
  seq += 1;
  return `toast:${seq}`;
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(id);
}

function durationFor(toast: Toast): number | null {
  if (toast.durationMs !== undefined) return toast.durationMs;
  if (toast.kind === "error") return null;
  return DEFAULT_DURATION_MS;
}

function dismissToast(id: string): void {
  if (!toasts.some((toast) => toast.id === id)) return;
  clearTimer(id);
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

function scheduleDismiss(toast: Toast): void {
  const duration = durationFor(toast);
  if (duration === null) return;
  if (duration <= 0) {
    dismissToast(toast.id);
    return;
  }
  clearTimer(toast.id);
  const timer = setTimeout(() => dismissToast(toast.id), duration);
  timer.unref?.();
  timers.set(toast.id, timer);
}

function pushToast(input: ToastInput): string {
  const toast: Toast = {
    ...input,
    id: input.id ?? nextId(),
  };

  clearTimer(toast.id);
  toasts = [toast, ...toasts.filter((current) => current.id !== toast.id)].slice(0, MAX_TOASTS);
  for (const id of Array.from(timers.keys())) {
    if (!toasts.some((current) => current.id === id)) clearTimer(id);
  }
  scheduleDismiss(toast);
  emit();
  return toast.id;
}

function clearToasts(): void {
  for (const id of Array.from(timers.keys())) clearTimer(id);
  toasts = [];
  emit();
}

export function useToasts(): {
  toasts: Toast[];
  push(toast: ToastInput): string;
  dismiss(id: string): void;
  clear(): void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    toasts: snapshot,
    push: pushToast,
    dismiss: dismissToast,
    clear: clearToasts,
  };
}

export function __clearToastsForTests(): void {
  seq = 0;
  clearToasts();
}
