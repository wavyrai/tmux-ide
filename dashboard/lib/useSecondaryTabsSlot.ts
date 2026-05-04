"use client";

import { useEffect, useId, useSyncExternalStore, type ReactNode } from "react";

interface Registration {
  id: string;
  node: ReactNode;
}

const listeners = new Set<() => void>();
let registrations: Registration[] = [];
let activeNode: ReactNode = null;

function recompute() {
  const next = registrations.length > 0 ? registrations[registrations.length - 1]!.node : null;
  if (next === activeNode) return;
  activeNode = next;
  for (const listener of listeners) listener();
}

function register(id: string, node: ReactNode): void {
  const index = registrations.findIndex((entry) => entry.id === id);
  if (index === -1) {
    registrations = [...registrations, { id, node }];
  } else {
    const next = registrations.slice();
    next[index] = { id, node };
    registrations = next;
  }
  recompute();
}

function unregister(id: string): void {
  const next = registrations.filter((entry) => entry.id !== id);
  if (next.length === registrations.length) return;
  registrations = next;
  recompute();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReactNode {
  return activeNode;
}

function getServerSnapshot(): ReactNode {
  return null;
}

export function useSecondaryTabsSlot(): ReactNode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function SecondaryTabsPortal({ children }: { children: ReactNode }) {
  const id = useId();
  useEffect(() => {
    register(id, children);
    return () => unregister(id);
  }, [id, children]);
  return null;
}
