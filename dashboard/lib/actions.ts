"use client";

import { useSyncExternalStore } from "react";

export interface ActionScope {
  section?: "global" | "project" | "terminal" | "settings";
  category?: string;
}

export interface Action {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  keybind?: string;
  scope?: ActionScope;
  category?: string;
  run(): unknown;
  isAvailable?(): boolean;
}

const actions = new Map<string, Action>();
const listeners = new Set<() => void>();
let snapshotCache: Action[] = [];
let snapshotDirty = true;

function emit(): void {
  snapshotDirty = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sortedActions(): Action[] {
  if (!snapshotDirty) return snapshotCache;

  snapshotCache = Array.from(actions.values()).sort((a, b) => {
    const category = (a.scope?.category ?? a.category ?? "").localeCompare(
      b.scope?.category ?? b.category ?? "",
    );
    if (category !== 0) return category;
    return a.label.localeCompare(b.label);
  });
  snapshotDirty = false;
  return snapshotCache;
}

function getSnapshot(): Action[] {
  return sortedActions();
}

function visibleActions(section?: string, predicate?: (action: Action) => boolean): Action[] {
  return sortedActions().filter((action) => {
    if (section && (action.scope?.section ?? "global") !== section) return false;
    if (predicate && !predicate(action)) return false;
    return action.isAvailable ? action.isAvailable() : true;
  });
}

export function registerAction(action: Action): () => void {
  actions.set(action.id, action);
  emit();

  return () => {
    if (actions.get(action.id) !== action) return;
    actions.delete(action.id);
    emit();
  };
}

export function useActions(
  filter?: { section?: string } | ((action: Action) => boolean),
): Action[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (typeof filter === "function") return visibleActions(undefined, filter);
  return visibleActions(filter?.section);
}

export function runAction(id: string): void {
  const action = actions.get(id);
  if (!action) return;
  if (action.isAvailable && !action.isAvailable()) return;
  void action.run();
}

export function __clearActionsForTests(): void {
  actions.clear();
  emit();
}
